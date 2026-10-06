// Read-only statistics over the `usage` table: one share user's detail and the filtered request log.
// (Overview and the user list are in overview.ts, built from cached hour partials.)
//
// `usage` is big (>1M rows and growing) and bun:sqlite is synchronous, so jobs run in a worker
// thread (see client.ts) against their own read-only connection. Pure functions of (db, params):
// no writes, nothing DPAPI-encrypted is read (`usage.model` is ciphertext — group on
// `requested_model` instead).

import type { Database } from "bun:sqlite";
import { HOUR, bucketOf } from "./parts.ts";
import { distinctModels, overviewRaw, shareUsersRaw, type HistRow } from "./overview.ts";

export { errorKindCounts, percentile } from "./overview.ts";

const DAY = 86400_000;
/** Newest rows a filtered log search may scan; keeps a rare-match search bounded. */
const SCAN_CAP = 2_000_000;

type Arg = string | number;

// ---------------------------------------------------------------------------
// one share user (detail): a single scan of that user's rows, aggregated here
// ---------------------------------------------------------------------------

export interface UserDetailRaw {
  totals: { n: number; err: number; i: number; c: number; o: number; r: number; d: number; ft: number; ftn: number };
  hourly: Array<{ t: number; n: number; err: number; i: number; o: number }>;
  byModel: Array<{ model: string; n: number; err: number; i: number; o: number }>;
  byEffort: Array<{ effort: string | null; n: number; o: number; r: number }>;
  errors: Array<{ status: number; e: string | null; n: number }>;
  durHist: HistRow[];
  ttftHist: HistRow[];
  clients: Array<{ client: string; n: number }>;
  sessions: number;
  ips: number;
  devices: number;
  activeDays: number;
  firstAt: number | null;
  lastAt: number | null;
  recent: Array<Record<string, unknown>>;
}

export function shareUserDetail(db: Database, p: { account: string; since: number; until: number; tzOffsetMs: number }): UserDetailRaw {
  const rows = db
    .query(
      `SELECT id, ts, provider, requested_model AS requestedModel, status, duration_ms AS durationMs, first_token_ms AS firstTokenMs,
        input_tokens AS input, cached_tokens AS cached, output_tokens AS output, reasoning_tokens AS reasoning, effort, error,
        client, session_key AS sessionKey, ip_hash AS ipHash, device
       FROM usage WHERE ts BETWEEN ? AND ? AND account_id = ? ORDER BY ts`,
    )
    .iterate(p.since, p.until, p.account) as Iterable<{
    id: number;
    ts: number;
    provider: string;
    requestedModel: string;
    status: number;
    durationMs: number;
    firstTokenMs: number | null;
    input: number;
    cached: number;
    output: number;
    reasoning: number;
    effort: string | null;
    error: string | null;
    client: string | null;
    sessionKey: string | null;
    ipHash: string | null;
    device: string | null;
  }>;
  const totals = { n: 0, err: 0, i: 0, c: 0, o: 0, r: 0, d: 0, ft: 0, ftn: 0 };
  const hourly = new Map<number, { t: number; n: number; err: number; i: number; o: number }>();
  const models = new Map<string, { model: string; n: number; err: number; i: number; o: number }>();
  const efforts = new Map<string, { effort: string | null; n: number; o: number; r: number }>();
  const errors = new Map<string, { status: number; e: string | null; n: number }>();
  const durHist = new Map<number, number>();
  const ttftHist = new Map<number, number>();
  const clients = new Map<string, number>();
  const sessions = new Set<string>();
  const ips = new Set<string>();
  const devices = new Set<string>();
  const days = new Set<number>();
  let firstAt: number | null = null;
  let lastAt: number | null = null;
  const recent: Array<Record<string, unknown>> = [];
  const bucket = bucketOf;

  for (const r of rows) {
    const failed = r.status >= 400 || !!r.error;
    totals.n++;
    if (failed) totals.err++;
    totals.i += r.input;
    totals.c += r.cached;
    totals.o += r.output;
    totals.r += r.reasoning;
    totals.d += r.durationMs;
    if (r.firstTokenMs != null) {
      totals.ft += r.firstTokenMs;
      totals.ftn++;
    }
    const ht = Math.floor(r.ts / HOUR) * HOUR;
    const h = hourly.get(ht) ?? { t: ht, n: 0, err: 0, i: 0, o: 0 };
    h.n++;
    if (failed) h.err++;
    h.i += r.input;
    h.o += r.output;
    hourly.set(ht, h);
    const m = models.get(r.requestedModel) ?? { model: r.requestedModel, n: 0, err: 0, i: 0, o: 0 };
    m.n++;
    if (failed) m.err++;
    m.i += r.input;
    m.o += r.output;
    models.set(r.requestedModel, m);
    const ek = r.effort ?? "";
    const e = efforts.get(ek) ?? { effort: r.effort, n: 0, o: 0, r: 0 };
    e.n++;
    e.o += r.output;
    e.r += r.reasoning;
    efforts.set(ek, e);
    if (failed) {
      const text = r.error ? r.error.slice(0, 120) : null;
      const key = `${r.status}|${text}`;
      const x = errors.get(key) ?? { status: r.status, e: text, n: 0 };
      x.n++;
      errors.set(key, x);
    } else {
      durHist.set(bucket(r.durationMs), (durHist.get(bucket(r.durationMs)) ?? 0) + 1);
      if (r.firstTokenMs != null) ttftHist.set(bucket(r.firstTokenMs), (ttftHist.get(bucket(r.firstTokenMs)) ?? 0) + 1);
    }
    if (r.client) clients.set(r.client, (clients.get(r.client) ?? 0) + 1);
    if (r.sessionKey && sessions.size < 20_000) sessions.add(r.sessionKey);
    if (r.ipHash && ips.size < 1000) ips.add(r.ipHash);
    if (r.device && devices.size < 1000) devices.add(r.device);
    days.add(Math.floor((r.ts + p.tzOffsetMs) / DAY));
    if (firstAt === null || r.ts < firstAt) firstAt = r.ts;
    if (lastAt === null || r.ts > lastAt) lastAt = r.ts;
    // Rows arrive in ts order (usage_ts): keep only the newest 50.
    recent.push(r as unknown as Record<string, unknown>);
    if (recent.length > 50) recent.shift();
  }
  const hist = (m: Map<number, number>) => [...m].map(([b, c]) => ({ b, c }));
  return {
    totals,
    hourly: [...hourly.values()].sort((a, b) => a.t - b.t),
    byModel: [...models.values()].sort((a, b) => b.n - a.n).slice(0, 12),
    byEffort: [...efforts.values()].sort((a, b) => b.n - a.n),
    errors: [...errors.values()].sort((a, b) => b.n - a.n).slice(0, 40),
    durHist: hist(durHist),
    ttftHist: hist(ttftHist),
    clients: [...clients].map(([client, n]) => ({ client, n })).sort((a, b) => b.n - a.n).slice(0, 5),
    sessions: sessions.size,
    ips: ips.size,
    devices: devices.size,
    activeDays: days.size,
    firstAt,
    lastAt,
    recent: recent.reverse(),
  };
}

// ---------------------------------------------------------------------------
// request log (filtered, keyset-paginated by id)
// ---------------------------------------------------------------------------

export interface RequestsFilter {
  limit: number;
  before?: number;
  provider?: string;
  source?: "pool" | "share";
  account?: string;
  status?: "ok" | "err";
  /** Resolved `requested_model` values (the display name is resolved by the caller). */
  models?: string[];
  effort?: string;
  minMs?: number;
  q?: string;
}

export interface RequestRowRaw {
  id: number;
  ts: number;
  provider: string;
  accountId: string | null;
  accountLabel: string | null;
  model: string;
  requestedModel: string;
  status: number;
  durationMs: number;
  firstTokenMs: number | null;
  input: number;
  cached: number;
  output: number;
  reasoning: number;
  effort: string | null;
  error: string | null;
  client: string | null;
  sessionKey: string | null;
  ipHash: string | null;
  device: string | null;
}

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

export function requestsRaw(db: Database, f: RequestsFilter): RequestRowRaw[] {
  const maxId = (db.query("SELECT max(id) AS m FROM usage").get() as { m: number | null }).m ?? 0;
  const parts = ["u.id > ?"];
  const args: Arg[] = [maxId - SCAN_CAP];
  if (f.before !== undefined) {
    parts.push("u.id < ?");
    args.push(f.before);
  }
  if (f.provider) {
    parts.push("u.provider = ?");
    args.push(f.provider);
  }
  if (f.source === "share") parts.push("u.account_id LIKE 'share:%'");
  else if (f.source === "pool") parts.push("(u.account_id IS NULL OR u.account_id NOT LIKE 'share:%')");
  if (f.account) {
    parts.push("u.account_id = ?");
    args.push(f.account);
  }
  if (f.status === "err") parts.push("(u.status >= 400 OR (u.error IS NOT NULL AND u.error != ''))");
  else if (f.status === "ok") parts.push("(u.status < 400 AND (u.error IS NULL OR u.error = ''))");
  if (f.models) {
    if (f.models.length === 0) parts.push("0");
    else {
      parts.push(`u.requested_model IN (${f.models.map(() => "?").join(",")})`);
      args.push(...f.models);
    }
  }
  if (f.effort) {
    if (f.effort === "none") parts.push("u.effort IS NULL");
    else {
      parts.push("u.effort = ?");
      args.push(f.effort);
    }
  }
  if (f.minMs !== undefined) {
    parts.push("u.duration_ms >= ?");
    args.push(f.minMs);
  }
  if (f.q) {
    parts.push("u.error LIKE ? ESCAPE '\\'");
    args.push(`%${escapeLike(f.q)}%`);
  }
  args.push(f.limit);
  return db
    .query(
      `SELECT u.id, u.ts, u.provider, u.account_id AS accountId, a.label AS accountLabel, u.model, u.requested_model AS requestedModel,
        u.status, u.duration_ms AS durationMs, u.first_token_ms AS firstTokenMs, u.input_tokens AS input, u.cached_tokens AS cached,
        u.output_tokens AS output, u.reasoning_tokens AS reasoning, u.effort, u.error, u.client, u.session_key AS sessionKey, u.ip_hash AS ipHash, u.device
       FROM usage u LEFT JOIN accounts a ON a.id = u.account_id WHERE ${parts.join(" AND ")} ORDER BY u.id DESC LIMIT ?`,
    )
    .all(...args) as RequestRowRaw[];
}

// ---------------------------------------------------------------------------

export const JOBS = {
  overview: overviewRaw,
  shareUsers: shareUsersRaw,
  shareUserDetail,
  requests: requestsRaw,
  models: distinctModels,
} as const;

export type JobName = keyof typeof JOBS;
export type JobParams<K extends JobName> = Parameters<(typeof JOBS)[K]>[1];
export type JobResult<K extends JobName> = ReturnType<(typeof JOBS)[K]>;

export function runJob<K extends JobName>(db: Database, name: K, params: JobParams<K>): JobResult<K> {
  const fn = JOBS[name] as (db: Database, p: JobParams<K>) => JobResult<K>;
  return fn(db, params);
}
