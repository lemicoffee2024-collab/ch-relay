// What the share endpoint records about its users beyond the usage row itself:
//   - salted hashes for "how many devices / networks / conversations" (never raw IPs or ids),
//   - rejected requests worth a glance (rate limited, not on the allowlist),
//   - the last quota reading seen on each user's own ChatGPT login.
// Everything here runs on the data plane (POST /v1/*), never behind a GET.

import { createHash, randomBytes } from "node:crypto";
import { getDb, getSetting, setSetting } from "../store/db.ts";
import { log } from "../lib/log.ts";
import type { ChatgptQuota } from "../providers/chatgpt/quota.ts";

// ---------------------------------------------------------------------------
// hashes
// ---------------------------------------------------------------------------

let salt: string | null = null;
function ipSalt(): string {
  if (salt) return salt;
  let s = getSetting<string | null>("share.ipSalt", null);
  if (!s) {
    s = randomBytes(16).toString("hex");
    setSetting("share.ipSalt", s);
  }
  return (salt = s);
}

const digest = (s: string, n: number) => createHash("sha256").update(ipSalt()).update(s).digest("hex").slice(0, n);

export interface ClientInfo {
  client: string | null;
  sessionKey: string | null;
  ipHash: string | null;
  device: string | null;
}

/** Peer address as the tunnel reports it; only ever stored as a salted hash. */
export function clientIpOf(headers: Headers, peer?: string | null): string | null {
  const raw = headers.get("cf-connecting-ip") ?? headers.get("x-forwarded-for")?.split(",")[0] ?? headers.get("x-real-ip") ?? peer ?? null;
  const ip = raw?.trim() ?? "";
  return ip && ip.length <= 64 ? ip : null;
}

/** Everything hashed or trimmed: safe to store and to show a read-only viewer. */
export function clientInfo(headers: Headers, opts: { peer?: string | null; sessionKey?: string | null } = {}): ClientInfo {
  const ua = (headers.get("user-agent") ?? "").replace(/[^\x20-\x7e]/g, "").slice(0, 80).trim();
  const ip = clientIpOf(headers, opts.peer);
  const install = headers.get("x-codex-installation-id");
  try {
    return {
      client: ua || null,
      sessionKey: opts.sessionKey ? digest(opts.sessionKey, 16) : null,
      ipHash: ip ? digest(ip, 12) : null,
      device: install ? digest(install, 12) : null,
    };
  } catch (err) {
    // A failure here must never fail the request it describes.
    log.error("client info failed", String(err));
    return { client: ua || null, sessionKey: null, ipHash: null, device: null };
  }
}

// ---------------------------------------------------------------------------
// rejection events (verified identities only), deduped and capped
// ---------------------------------------------------------------------------

export type ShareEventKind = "rate_limited" | "denied";

const FLUSH_MS = 30_000;
const MAX_PENDING = 200;
const MAX_ROWS_PER_HOUR = 500;
export const EVENT_RETENTION_MS = 30 * 86400_000;

interface Pending {
  ts: number;
  kind: ShareEventKind;
  email: string;
  ipHash: string | null;
  detail: string | null;
  n: number;
}

const pending = new Map<string, Pending>();
let hourStart = 0;
let hourRows = 0;
let timer: ReturnType<typeof setTimeout> | null = null;

/** Counts a rejection; rows are written in batches, one per (kind, email) per flush window. */
export function recordShareEvent(kind: ShareEventKind, email: string, ipHash: string | null, detail?: string): void {
  try {
    const key = `${kind}|${email}`;
    const hit = pending.get(key);
    if (hit) {
      hit.n++;
      return;
    }
    if (pending.size >= MAX_PENDING) return;
    pending.set(key, { ts: Date.now(), kind, email, ipHash, detail: detail?.slice(0, 120) ?? null, n: 1 });
    if (!timer) {
      timer = setTimeout(flushShareEvents, FLUSH_MS);
      (timer as unknown as { unref?: () => void }).unref?.();
    }
  } catch (err) {
    log.error("share event failed", String(err));
  }
}

export function flushShareEvents(): void {
  if (timer) clearTimeout(timer);
  timer = null;
  if (pending.size === 0) return;
  const rows = [...pending.values()];
  pending.clear();
  try {
    const now = Date.now();
    if (now - hourStart >= 3600_000) {
      hourStart = now;
      hourRows = 0;
    }
    const d = getDb();
    const ins = d.query("INSERT INTO share_events(ts, kind, email, ip_hash, detail, n) VALUES (?, ?, ?, ?, ?, ?)");
    d.transaction(() => {
      for (const r of rows) {
        if (hourRows >= MAX_ROWS_PER_HOUR) return;
        ins.run(r.ts, r.kind, r.email, r.ipHash, r.detail, r.n);
        hourRows++;
      }
    })();
  } catch (err) {
    log.error("share event flush failed", String(err));
  }
}

export function purgeShareEvents(now = Date.now()): number {
  return getDb().query("DELETE FROM share_events WHERE ts < ?").run(now - EVENT_RETENTION_MS).changes;
}

export interface ShareEventRow {
  id: number;
  ts: number;
  kind: ShareEventKind;
  email: string | null;
  detail: string | null;
  n: number;
}

export function listShareEvents(opts: { limit: number; email?: string; since?: number }): ShareEventRow[] {
  const parts = ["ts >= ?"];
  const args: Array<string | number> = [opts.since ?? 0];
  if (opts.email) {
    parts.push("email = ?");
    args.push(opts.email);
  }
  args.push(opts.limit);
  return getDb()
    .query(`SELECT id, ts, kind, email, detail, n FROM share_events WHERE ${parts.join(" AND ")} ORDER BY id DESC LIMIT ?`)
    .all(...args) as ShareEventRow[];
}

/** Rejections per user since `since`, plus totals per kind. */
export function shareEventCounts(since: number): { byEmail: Map<string, Record<string, number>>; total: Record<string, number> } {
  const rows = getDb()
    .query("SELECT email, kind, sum(n) AS n FROM share_events WHERE ts >= ? GROUP BY email, kind")
    .all(since) as Array<{ email: string | null; kind: string; n: number }>;
  const byEmail = new Map<string, Record<string, number>>();
  const total: Record<string, number> = {};
  for (const r of rows) {
    total[r.kind] = (total[r.kind] ?? 0) + r.n;
    if (!r.email) continue;
    const m = byEmail.get(r.email) ?? {};
    m[r.kind] = (m[r.kind] ?? 0) + r.n;
    byEmail.set(r.email, m);
  }
  return { byEmail, total };
}

// ---------------------------------------------------------------------------
// last quota reading per user (whitelisted numbers only)
// ---------------------------------------------------------------------------

export interface ShareQuota {
  shortPercent: number | null;
  shortResetAt: number | null;
  weeklyPercent: number | null;
  weeklyResetAt: number | null;
  plan: string | null;
  updatedAt: number;
}

const QUOTA_MIN_GAP_MS = 60_000;
const lastQuota = new Map<string, { at: number; sig: string }>();

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

export function saveShareQuota(email: string, q: ChatgptQuota): void {
  try {
    const row = {
      short_percent: num(q.shortPercent),
      short_reset_at: num(q.shortResetAt),
      weekly_percent: num(q.weeklyPercent),
      weekly_reset_at: num(q.weeklyResetAt),
      plan: typeof q.plan === "string" && /^[A-Za-z0-9_ -]{1,24}$/.test(q.plan) ? q.plan : null,
    };
    const sig = JSON.stringify([row.short_percent, row.weekly_percent, row.plan]);
    const now = Date.now();
    const last = lastQuota.get(email);
    // Reset stamps drift by seconds between calls, so the signature ignores them: an unchanged
    // reading is rewritten at most every 10 minutes, a changed one at most every minute.
    if (last && last.sig === sig && now - last.at < 10 * 60_000) return;
    if (last && now - last.at < QUOTA_MIN_GAP_MS) return;
    lastQuota.set(email, { at: now, sig });
    getDb()
      .query(
        `INSERT INTO share_quota(email, short_percent, short_reset_at, weekly_percent, weekly_reset_at, plan, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(email) DO UPDATE SET short_percent = excluded.short_percent, short_reset_at = excluded.short_reset_at,
           weekly_percent = excluded.weekly_percent, weekly_reset_at = excluded.weekly_reset_at, plan = excluded.plan, updated_at = excluded.updated_at`,
      )
      .run(email, row.short_percent, row.short_reset_at, row.weekly_percent, row.weekly_reset_at, row.plan, now);
  } catch (err) {
    log.error("share quota save failed", String(err));
  }
}

// ---- quota_samples: every meter reading, kept for delta analysis ----

const SAMPLE_GAP_MS = 60_000; // identical readings collapse within a minute
const lastSample = new Map<string, { at: number; sig: string }>();
const lastLoggedSig = new Map<string, string>();

/** Append a meter reading to quota_samples. Dedupes identical readings seen
 *  within a minute (the meter moves in jumps, not per request); logs when the
 *  percent actually moves — that jump is the per-request cost signal. */
export function recordQuotaSample(email: string, q: ChatgptQuota, source: "hdr" | "wham"): void {
  try {
    const short = num(q.shortPercent);
    const weekly = num(q.weeklyPercent);
    if (short === null && weekly === null) return;
    const sig = `${short}|${weekly}`;
    const now = Date.now();
    const key = `${email}|${source}`;
    const last = lastSample.get(key);
    if (last && last.sig === sig && now - last.at < SAMPLE_GAP_MS) return;
    lastSample.set(key, { at: now, sig });
    getDb()
      .query(
        `INSERT INTO quota_samples(ts, email, source, short_percent, short_reset_at, weekly_percent, weekly_reset_at, plan)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(now, email, source, short, num(q.shortResetAt), weekly, num(q.weeklyResetAt), q.plan ?? null);
    const prev = lastLoggedSig.get(email);
    if (prev !== sig) {
      const prevShort = prev?.split("|")[0];
      log.info(
        `share quota: short=${short}%${prev && prevShort !== String(short) ? ` (was ${prevShort}%)` : ""} weekly=${weekly}% src=${source} user=${email}`,
      );
      lastLoggedSig.set(email, sig);
    }
  } catch (err) {
    log.error("quota sample save failed", String(err));
  }
}

export function purgeQuotaSamples(now = Date.now()): number {
  return getDb().query("DELETE FROM quota_samples WHERE ts < ?").run(now - 30 * 24 * 3600_000).changes;
}

export function listShareQuotas(): Map<string, ShareQuota> {
  const rows = getDb().query("SELECT * FROM share_quota").all() as Array<{
    email: string;
    short_percent: number | null;
    short_reset_at: number | null;
    weekly_percent: number | null;
    weekly_reset_at: number | null;
    plan: string | null;
    updated_at: number;
  }>;
  return new Map(
    rows.map((r) => [
      r.email,
      { shortPercent: r.short_percent, shortResetAt: r.short_reset_at, weeklyPercent: r.weekly_percent, weeklyResetAt: r.weekly_reset_at, plan: r.plan, updatedAt: r.updated_at },
    ]),
  );
}

/** For tests. */
export function resetShareTelemetry(): void {
  pending.clear();
  lastQuota.clear();
  if (timer) clearTimeout(timer);
  timer = null;
  hourStart = 0;
  hourRows = 0;
  salt = null;
}
