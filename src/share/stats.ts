// Per-user statistics for the share endpoint: what each person actually uses, how well it
// works for them, and whether anything about them deserves a look. Read-only.

import { stat } from "../stats/client.ts";
import { errorKindCounts, percentile } from "../stats/queries.ts";
import { errorKind } from "../lib/error-kind.ts";
import { redact } from "../lib/log.ts";
import { displayModel, modelDisplayMap, quantizeWindow } from "../usage.ts";
import { getShareUser, listShareUsers, normalizeEmail, shareAccountId, type ShareUser } from "./users.ts";
import { listShareEvents, listShareQuotas, shareEventCounts, type ShareQuota } from "./telemetry.ts";

const DAY = 86400_000;
const HOUR = 3600_000;

/** Server-local offset, so "active days" follow the operator's calendar. */
const tzOffset = () => -new Date().getTimezoneOffset() * 60_000;

export type UserTag = "heavy" | "steady" | "idle" | "dormant" | "never" | "errors" | "limited" | "expiring" | "multi" | "new" | "denied";

export interface UserRow {
  email: string;
  label: string | null;
  enabled: boolean;
  /** No longer on the allowlist, but has requests in the window. */
  removed: boolean;
  createdAt: number | null;
  lastSeenAt: number | null;
  expiresAt: number | null;
  requests: number;
  errors: number;
  errorRate: number;
  input: number;
  cached: number;
  output: number;
  reasoning: number;
  tokens: number;
  cacheRate: number;
  /** Share of all share-user tokens in the window. */
  tokenShare: number;
  avgMs: number;
  firstAt: number | null;
  lastAt: number | null;
  activeDays: number;
  ips: number;
  devices: number;
  topModel: string | null;
  topEffort: string | null;
  spark: number[];
  limitHits: number;
  denied: number;
  quota: ShareQuota | null;
  tags: UserTag[];
  /** What to do about it, if anything. */
  advice: string | null;
}

const num = (v: number | null | undefined) => v ?? 0;

interface TagCtx {
  now: number;
  spanDays: number;
}

export function tagsFor(u: Omit<UserRow, "tags" | "advice">, ctx: TagCtx): { tags: UserTag[]; advice: string | null } {
  const tags: UserTag[] = [];
  const active = u.requests > 0;
  if (!u.removed) {
    if (u.lastSeenAt === null && !active) tags.push("never");
    else if (!active) tags.push(u.createdAt !== null && ctx.now - u.createdAt > ctx.spanDays * DAY ? "dormant" : "idle");
    if (u.createdAt !== null && ctx.now - u.createdAt < 2 * DAY) tags.push("new");
    if (u.expiresAt !== null && u.expiresAt > ctx.now && u.expiresAt - ctx.now < 3 * DAY) tags.push("expiring");
  }
  if (active) {
    if (u.tokenShare >= 0.2 || (u.tokenShare >= 0.1 && u.tokens >= 5_000_000)) tags.push("heavy");
    if (ctx.spanDays >= 3 && u.activeDays / ctx.spanDays >= 0.6) tags.push("steady");
    if (u.requests >= 20 && u.errorRate >= 0.1) tags.push("errors");
    if (u.devices >= 3 || u.ips >= 6) tags.push("multi");
  }
  if (u.limitHits > 0) tags.push("limited");
  if (u.denied > 0) tags.push("denied");

  let advice: string | null = null;
  if (tags.includes("expiring") && tags.includes("steady")) advice = "Đang dùng đều, sắp hết hạn: cân nhắc gia hạn";
  else if (tags.includes("dormant")) advice = "Không dùng trong kỳ này: cân nhắc xoá để gọn danh sách";
  else if (tags.includes("never")) advice = "Chưa từng kết nối: kiểm tra đã cài đặt chưa";
  else if (tags.includes("errors")) advice = "Tỉ lệ lỗi cao: xem chi tiết lỗi của người này";
  else if (tags.includes("multi")) advice = "Một email xuất hiện trên nhiều thiết bị/mạng: kiểm tra có bị dùng chung không";
  else if (tags.includes("limited")) advice = "Từng chạm giới hạn tốc độ (8 luồng, 60 yêu cầu/phút)";
  return { tags, advice };
}

function top(counts: Map<string, number>): string | null {
  let best: string | null = null;
  let n = 0;
  for (const [k, v] of counts) if (v > n) [best, n] = [k, v];
  return best;
}

export async function shareStats(since: number, until: number) {
  const w = quantizeWindow(since, until);
  const tz = tzOffset();
  const now = Date.now();
  const raw = await stat("shareUsers", { since: w.since, until: w.until, tzOffsetMs: tz }, w.ttl);
  const names = await modelDisplayMap();
  const spanDays = Math.max(1, Math.round((w.until - w.since) / DAY));

  const stats = new Map(raw.map((r) => [r.a.slice("share:".length), r]));
  const dayEnd = Math.floor((w.until + tz) / DAY);
  const sparkOf = (days: Array<[number, number]>) => {
    const arr: number[] = new Array(7).fill(0);
    for (const [day, n] of days) {
      const back = dayEnd - day;
      if (back >= 0 && back < 7) arr[6 - back] = n;
    }
    return arr;
  };
  /** Several slugs can share one display name: merge before picking the winner. */
  const topModelOf = (models: Array<[string, number]>) => {
    const m = new Map<string, number>();
    for (const [slug, n] of models) {
      const shown = displayModel(names, "chatgpt", slug);
      m.set(shown, (m.get(shown) ?? 0) + n);
    }
    return top(m);
  };
  const topEffortOf = (efforts: Array<[string | null, number]>) => (efforts[0] ? (efforts[0][0] ?? "mặc định") : null);

  const events = shareEventCounts(w.since);
  const quotas = listShareQuotas();
  const list = listShareUsers();
  const listed = new Set(list.map((u) => u.email));
  const entries: Array<{ email: string; user: ShareUser | null }> = [
    ...list.map((user) => ({ email: user.email, user })),
    ...[...stats.keys()].filter((e) => !listed.has(e)).map((email) => ({ email, user: null })),
  ];

  const totalTokens = raw.reduce((a, r) => a + num(r.i) + num(r.o), 0);
  const rows: UserRow[] = entries.map(({ email, user }) => {
    const s = stats.get(email);
    const ev = events.byEmail.get(email) ?? {};
    const base = {
      email,
      label: user?.label ?? null,
      enabled: user?.enabled ?? false,
      removed: !user,
      createdAt: user?.createdAt ?? null,
      lastSeenAt: user?.lastSeenAt ?? null,
      expiresAt: user?.expiresAt ?? null,
      requests: s?.n ?? 0,
      errors: s?.err ?? 0,
      errorRate: s && s.n ? s.err / s.n : 0,
      input: num(s?.i),
      cached: num(s?.c),
      output: num(s?.o),
      reasoning: num(s?.r),
      tokens: num(s?.i) + num(s?.o),
      cacheRate: s && s.i ? num(s.c) / s.i : 0,
      tokenShare: totalTokens ? (num(s?.i) + num(s?.o)) / totalTokens : 0,
      avgMs: s && s.n ? s.d / s.n : 0,
      firstAt: s?.first ?? null,
      lastAt: s?.last ?? null,
      activeDays: s?.days.length ?? 0,
      ips: s?.ips ?? 0,
      devices: s?.devs ?? 0,
      topModel: s ? topModelOf(s.models) : null,
      topEffort: s ? topEffortOf(s.efforts) : null,
      spark: s ? sparkOf(s.days) : new Array(7).fill(0),
      limitHits: ev.rate_limited ?? 0,
      denied: ev.denied ?? 0,
      quota: quotas.get(email) ?? null,
    };
    return { ...base, ...tagsFor(base, { now, spanDays }) };
  });
  rows.sort((a, b) => b.tokens - a.tokens || b.requests - a.requests);

  const top3 = rows.slice(0, 3).reduce((a, r) => a + r.tokens, 0);
  const seen = (ms: number) => list.filter((u) => u.lastSeenAt !== null && now - u.lastSeenAt <= ms).length;
  const ev24 = shareEventCounts(now - DAY).total;
  return {
    range: { since: w.since, until: w.until },
    summary: {
      users: list.length,
      enabled: list.filter((u) => u.enabled).length,
      active1h: seen(HOUR),
      active24h: seen(DAY),
      active7d: seen(7 * DAY),
      // Same definition as the "never" tag: no connection on record and no requests in the window.
      neverConnected: rows.filter((r) => r.tags.includes("never")).length,
      expiringSoon: list.filter((u) => u.expiresAt !== null && u.expiresAt > now && u.expiresAt - now < 3 * DAY).length,
      withRequests: rows.filter((r) => r.requests > 0).length,
      requests: raw.reduce((a, r) => a + r.n, 0),
      errors: raw.reduce((a, r) => a + r.err, 0),
      tokens: totalTokens,
      top3Share: totalTokens ? top3 / totalTokens : 0,
      rateLimited24h: ev24.rate_limited ?? 0,
      denied24h: ev24.denied ?? 0,
    },
    users: rows,
    events: listShareEvents({ limit: 30, since: now - 7 * DAY }),
  };
}

export async function shareUserStats(rawEmail: string, since: number, until: number) {
  const email = normalizeEmail(rawEmail);
  const w = quantizeWindow(since, until);
  const tz = tzOffset();
  const raw = await stat("shareUserDetail", { account: shareAccountId(email), since: w.since, until: w.until, tzOffsetMs: tz }, w.ttl);
  const names = await modelDisplayMap();
  const user = getShareUser(email);
  const t = raw.totals;

  const merged = new Map<string, { model: string; requests: number; errors: number; input: number; output: number }>();
  for (const m of raw.byModel) {
    const model = displayModel(names, "chatgpt", m.model);
    const x = merged.get(model) ?? { model, requests: 0, errors: 0, input: 0, output: 0 };
    x.requests += m.n; x.errors += m.err; x.input += m.i; x.output += m.o;
    merged.set(model, x);
  }
  return {
    email,
    label: user?.label ?? null,
    enabled: user?.enabled ?? false,
    removed: !user,
    createdAt: user?.createdAt ?? null,
    lastSeenAt: user?.lastSeenAt ?? null,
    expiresAt: user?.expiresAt ?? null,
    range: { since: w.since, until: w.until },
    totals: {
      requests: t.n, errors: t.err, input: t.i, cached: t.c, output: t.o, reasoning: t.r,
      errorRate: t.n ? t.err / t.n : 0,
      cacheRate: t.i ? t.c / t.i : 0,
      avgMs: t.n ? t.d / t.n : 0,
      avgFirstTokenMs: t.ftn ? t.ft / t.ftn : null,
    },
    latency: {
      p50: percentile(raw.durHist, 0.5), p95: percentile(raw.durHist, 0.95), p99: percentile(raw.durHist, 0.99),
      ttftP50: percentile(raw.ttftHist, 0.5), ttftP95: percentile(raw.ttftHist, 0.95),
    },
    hourly: raw.hourly.map((h) => ({ t: h.t, requests: h.n, errors: h.err, input: h.i, output: h.o })),
    byModel: [...merged.values()].sort((a, b) => b.requests - a.requests),
    byEffort: raw.byEffort.map((e) => ({ effort: e.effort, requests: e.n, output: e.o, reasoning: e.r })),
    errorKinds: errorKindCounts(raw.errors),
    clients: raw.clients,
    sessions: raw.sessions,
    ips: raw.ips,
    devices: raw.devices,
    activeDays: raw.activeDays,
    firstAt: raw.firstAt,
    lastAt: raw.lastAt,
    events: listShareEvents({ email, limit: 20 }),
    quota: listShareQuotas().get(email) ?? null,
    recent: raw.recent.map((r) => {
      const row = r as Record<string, unknown>;
      const error = typeof row.error === "string" ? row.error : null;
      return {
        id: row.id,
        ts: row.ts,
        requestedModel: displayModel(names, "chatgpt", String(row.requestedModel)),
        status: row.status,
        durationMs: row.durationMs,
        firstTokenMs: row.firstTokenMs,
        input: row.input,
        cached: row.cached,
        output: row.output,
        reasoning: row.reasoning,
        effort: row.effort,
        error: error ? redact(error) : null,
        kind: errorKind(Number(row.status), error),
        client: row.client,
        session: typeof row.sessionKey === "string" ? row.sessionKey.slice(0, 8) : null,
        ip: typeof row.ipHash === "string" ? row.ipHash.slice(0, 6) : null,
        device: typeof row.device === "string" ? row.device.slice(0, 6) : null,
      };
    }),
  };
}

/** Last-24h request/token counts per email, for the management table. */
export async function shareLast24h(): Promise<Map<string, { requests: number; tokens: number }>> {
  const w = quantizeWindow(Date.now() - DAY, Date.now());
  const rows = await stat("shareUsers", { since: w.since, until: w.until, tzOffsetMs: tzOffset() }, w.ttl);
  return new Map(rows.map((r) => [r.a, { requests: r.n, tokens: r.i + r.o }]));
}
