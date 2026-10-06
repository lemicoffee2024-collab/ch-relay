// Hour-sized partial aggregates of `usage`.
//
// One pass over an hour's rows yields everything the dashboards need (groups, hourly points,
// error texts, latency histograms, device/network/session sets). Partials are additive, so any
// window is just the sum of its hours. Hours that can no longer receive rows are cached in this
// process's memory: a 30-day view then costs a merge of cached hours plus one live hour instead
// of a scan of millions of rows. (Rows are stamped with the request START but written when the
// request ENDS, hence the late-write slack before an hour counts as closed.)

import type { Database } from "bun:sqlite";

export const HOUR = 3600_000;
/** Longest a request may run and still land in its start hour before we treat the hour as final. */
export const LATE_MS = 30 * 60_000;
/** Below this many hours a window is scanned exactly instead of by whole hours. */
export const EXACT_MAX_MS = 3 * HOUR;
/** ~90 days of hours; empty hours are remembered separately and cost almost nothing. */
const MAX_PARTS = 2200;
/**
 * Memory budget: total (account, model, effort) groups held across cached hours. Measured at about
 * 0.5 KB per group including the other maps (~68 KB per hour at ~125 groups/hour), so this is
 * roughly 100 MB: a 30-day view plus the 30 days before it. Oldest hours go first; an evicted hour
 * is simply recomputed when asked for.
 */
const DEFAULT_MAX_GROUPS = 190_000;
let MAX_GROUPS = DEFAULT_MAX_GROUPS;

/** For tests. */
export function setPartBudgetForTests(groups: number | null): void {
  MAX_GROUPS = groups ?? DEFAULT_MAX_GROUPS;
}
export const BUCKETS = 541;

/** Latency bucket: 20 ms steps under 1 s, 100 ms steps under 10 s, 1 s steps above (cap 410 s). */
export function bucketOf(ms: number): number {
  if (ms < 1000) return Math.max(0, Math.floor(ms / 20));
  if (ms < 10_000) return 50 + Math.floor((ms - 1000) / 100);
  return 140 + Math.min(Math.floor((ms - 10_000) / 1000), 400);
}

export interface G {
  provider: string;
  account: string | null;
  model: string;
  effort: string | null;
  n: number;
  err: number;
  i: number;
  c: number;
  o: number;
  r: number;
  d: number;
  ft: number;
  ftn: number;
  tpsOut: number;
  tpsMs: number;
  first: number;
  last: number;
}

export interface HourlyPoint {
  hour: number;
  provider: string;
  share: boolean;
  n: number;
  err: number;
  i: number;
  o: number;
}

export interface ErrorRow {
  provider: string;
  share: boolean;
  status: number;
  e: string | null;
  n: number;
}

export interface HistPair {
  provider: string;
  share: boolean;
  dur: Uint32Array;
  ttft: Uint32Array;
}

export interface IdSets {
  ips: Set<string>;
  devs: Set<string>;
}

export interface Part {
  /** First instant this part covers (an hour boundary for cached parts). */
  from: number;
  groups: Map<string, G>;
  hourly: Map<string, HourlyPoint>;
  errors: Map<string, ErrorRow>;
  hist: Map<string, HistPair>;
  ids: Map<string, IdSets>;
}

// Provider, model, effort, account and hash strings repeat in every hour: share one copy of each.
const pool = new Map<string, string>();
function intern(s: string): string;
function intern(s: string | null): string | null;
function intern(s: string | null): string | null {
  if (s === null) return null;
  let v = pool.get(s);
  if (v === undefined) {
    if (pool.size > 200_000) pool.clear();
    pool.set(s, (v = s));
  }
  return v;
}

interface Row {
  ts: number;
  provider: string;
  account_id: string | null;
  requested_model: string;
  effort: string | null;
  status: number;
  duration_ms: number;
  first_token_ms: number | null;
  input_tokens: number;
  cached_tokens: number;
  output_tokens: number;
  reasoning_tokens: number;
  error: string | null;
  ip_hash: string | null;
  device: string | null;
}

const ID_CAP = 5000;

/** Aggregate the rows with `from <= ts < to` in a single pass. */
export function computePart(db: Database, from: number, to: number): Part {
  const part: Part = { from, groups: new Map(), hourly: new Map(), errors: new Map(), hist: new Map(), ids: new Map() };
  const rows = db
    .query(
      `SELECT ts, provider, account_id, requested_model, effort, status, duration_ms, first_token_ms, input_tokens, cached_tokens,
        output_tokens, reasoning_tokens, error, ip_hash, device
       FROM usage WHERE ts >= ? AND ts < ?`,
    )
    .iterate(from, to) as Iterable<Row>;
  for (const r of rows) {
    const share = r.account_id !== null && r.account_id.startsWith("share:");
    const provider = intern(r.provider);
    const failed = r.status >= 400 || (r.error !== null && r.error !== "");
    const gk = `${provider}\u0001${r.account_id}\u0001${r.requested_model}\u0001${r.effort}`;
    let g = part.groups.get(gk);
    if (!g) {
      g = { provider, account: intern(r.account_id), model: intern(r.requested_model), effort: intern(r.effort), n: 0, err: 0, i: 0, c: 0, o: 0, r: 0, d: 0, ft: 0, ftn: 0, tpsOut: 0, tpsMs: 0, first: r.ts, last: r.ts };
      part.groups.set(gk, g);
    }
    g.n++;
    if (failed) g.err++;
    g.i += r.input_tokens;
    g.c += r.cached_tokens;
    g.o += r.output_tokens;
    g.r += r.reasoning_tokens;
    g.d += r.duration_ms;
    if (r.first_token_ms !== null) {
      g.ft += r.first_token_ms;
      g.ftn++;
      if (!failed && r.duration_ms > r.first_token_ms && r.output_tokens > 0) {
        g.tpsOut += r.output_tokens;
        g.tpsMs += r.duration_ms - r.first_token_ms;
      }
    }
    if (r.ts < g.first) g.first = r.ts;
    if (r.ts > g.last) g.last = r.ts;

    const hour = Math.floor(r.ts / HOUR) * HOUR;
    const hk = `${hour}\u0001${provider}\u0001${share ? 1 : 0}`;
    let h = part.hourly.get(hk);
    if (!h) part.hourly.set(hk, (h = { hour, provider, share, n: 0, err: 0, i: 0, o: 0 }));
    h.n++;
    if (failed) h.err++;
    h.i += r.input_tokens;
    h.o += r.output_tokens;

    if (failed) {
      const text = r.error ? r.error.slice(0, 120) : null;
      const ek = `${provider}\u0001${share ? 1 : 0}\u0001${r.status}\u0001${text}`;
      const e = part.errors.get(ek);
      if (e) e.n++;
      else part.errors.set(ek, { provider, share, status: r.status, e: text, n: 1 });
    } else {
      const pk = `${provider}\u0001${share ? 1 : 0}`;
      let p = part.hist.get(pk);
      if (!p) part.hist.set(pk, (p = { provider, share, dur: new Uint32Array(BUCKETS), ttft: new Uint32Array(BUCKETS) }));
      p.dur[bucketOf(r.duration_ms)]!++;
      if (r.first_token_ms !== null) p.ttft[bucketOf(r.first_token_ms)]!++;
    }

    if (share && r.account_id) {
      const acct = intern(r.account_id);
      let s = part.ids.get(acct);
      if (!s) part.ids.set(acct, (s = { ips: new Set(), devs: new Set() }));
      if (r.ip_hash && s.ips.size < ID_CAP) s.ips.add(intern(r.ip_hash));
      if (r.device && s.devs.size < ID_CAP) s.devs.add(intern(r.device));
    }
  }
  return part;
}

// ---------------------------------------------------------------------------
// cache of closed hours (per database handle, in memory only)
// ---------------------------------------------------------------------------

interface Cache {
  parts: Map<number, Part>;
  /** Groups held by `parts` (see MAX_GROUPS). */
  groups: number;
  /** Closed hours with no rows at all (a 90-day window is mostly these on a young install). */
  empty: Set<number>;
}

const caches = new WeakMap<Database, Cache>();

function cacheOf(db: Database): Cache {
  let c = caches.get(db);
  if (!c) caches.set(db, (c = { parts: new Map(), groups: 0, empty: new Set() }));
  return c;
}

/** Parts covering `[since, until]`: exact for short windows, whole cached hours otherwise. */
export function collect(db: Database, since: number, until: number, now = Date.now()): Part[] {
  if (until - since <= EXACT_MAX_MS) return [computePart(db, since, until + 1)];
  const cache = cacheOf(db);
  const out: Part[] = [];
  for (let h = Math.floor(since / HOUR) * HOUR; h <= until; h += HOUR) {
    if (cache.empty.has(h)) continue;
    let p = cache.parts.get(h);
    if (!p) {
      p = computePart(db, h, h + HOUR);
      const closed = h + HOUR + LATE_MS <= now;
      if (p.groups.size === 0) {
        if (closed) cache.empty.add(h);
        continue;
      }
      if (closed) {
        cache.parts.set(h, p);
        cache.groups += p.groups.size;
        while (cache.parts.size > MAX_PARTS || (cache.groups > MAX_GROUPS && cache.parts.size > 1)) {
          const oldest = cache.parts.keys().next().value!;
          cache.groups -= cache.parts.get(oldest)!.groups.size;
          cache.parts.delete(oldest);
        }
      }
    }
    out.push(p);
  }
  return out;
}

/** Drop every cached hour of `db` (tests, or after rows are backfilled). */
export function clearParts(db: Database): void {
  caches.delete(db);
}

/** Number of cached hours (for tests and diagnostics). */
export function cachedHours(db: Database): number {
  return cacheOf(db).parts.size;
}
