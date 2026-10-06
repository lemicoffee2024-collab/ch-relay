// Overview and share-user-list statistics, built by summing cached hour partials (parts.ts).
// Pure functions of (db, params); run inside the stats worker (see client.ts).

import type { Database } from "bun:sqlite";
import { errorKind } from "../lib/error-kind.ts";
import { BUCKETS, HOUR, collect } from "./parts.ts";

const DAY = 86400_000;

// ---------------------------------------------------------------------------
// latency histogram helpers (the bucket layout lives in parts.ts)
// ---------------------------------------------------------------------------

export interface HistRow {
  b: number;
  c: number;
}

export function bucketMid(b: number): number {
  if (b < 50) return b * 20 + 10;
  if (b < 140) return 1000 + (b - 50) * 100 + 50;
  return 10_000 + (b - 140) * 1000 + 500;
}

/** Percentile (0..1) of a bucket histogram, as the bucket midpoint in ms; null when empty. */
export function percentile(rows: HistRow[], p: number): number | null {
  const total = rows.reduce((a, r) => a + r.c, 0);
  if (total === 0) return null;
  const target = Math.max(1, Math.ceil(p * total));
  let cum = 0;
  for (const r of [...rows].sort((a, b) => a.b - b.b)) {
    cum += r.c;
    if (cum >= target) return bucketMid(r.b);
  }
  return null;
}

const toRows = (a: Uint32Array): HistRow[] => {
  const out: HistRow[] = [];
  for (let b = 0; b < a.length; b++) if (a[b]) out.push({ b, c: a[b]! });
  return out;
};

// ---------------------------------------------------------------------------
// overview
// ---------------------------------------------------------------------------

export interface Scope {
  since: number;
  until: number;
  provider?: string;
  source?: "pool" | "share";
}

const keeps = (s: Scope, provider: string, share: boolean) => (!s.provider || s.provider === provider) && (!s.source || (s.source === "share") === share);

export interface OverviewGroup {
  provider: string;
  account_id: string | null;
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
}

export interface OverviewRaw {
  groups: OverviewGroup[];
  hourly: Array<{ t: number; n: number; err: number; i: number; o: number }>;
  errors: Array<{ status: number; e: string | null; n: number }>;
  durHist: HistRow[];
  ttftHist: HistRow[];
  prev: { n: number; err: number; i: number; c: number; o: number; d: number } | null;
}

export function overviewRaw(db: Database, s: Scope): OverviewRaw {
  const groups = new Map<string, OverviewGroup>();
  const hourly = new Map<number, { t: number; n: number; err: number; i: number; o: number }>();
  const errors = new Map<string, { status: number; e: string | null; n: number }>();
  const dur = new Uint32Array(BUCKETS);
  const ttft = new Uint32Array(BUCKETS);
  // Whole-hour parts include the hours' full extent; hourly points before `since` belong to the first partial hour.
  const firstHour = Math.floor(s.since / HOUR) * HOUR;
  for (const p of collect(db, s.since, s.until)) {
    for (const g of p.groups.values()) {
      if (!keeps(s, g.provider, g.account?.startsWith("share:") ?? false)) continue;
      const k = `${g.provider}\u0001${g.account}\u0001${g.model}\u0001${g.effort}`;
      const x = groups.get(k);
      if (!x) {
        groups.set(k, { provider: g.provider, account_id: g.account, model: g.model, effort: g.effort, n: g.n, err: g.err, i: g.i, c: g.c, o: g.o, r: g.r, d: g.d, ft: g.ft, ftn: g.ftn, tpsOut: g.tpsOut, tpsMs: g.tpsMs });
      } else {
        x.n += g.n; x.err += g.err; x.i += g.i; x.c += g.c; x.o += g.o; x.r += g.r; x.d += g.d;
        x.ft += g.ft; x.ftn += g.ftn; x.tpsOut += g.tpsOut; x.tpsMs += g.tpsMs;
      }
    }
    for (const h of p.hourly.values()) {
      if (!keeps(s, h.provider, h.share) || h.hour < firstHour) continue;
      const x = hourly.get(h.hour) ?? { t: h.hour, n: 0, err: 0, i: 0, o: 0 };
      x.n += h.n; x.err += h.err; x.i += h.i; x.o += h.o;
      hourly.set(h.hour, x);
    }
    for (const e of p.errors.values()) {
      if (!keeps(s, e.provider, e.share)) continue;
      const k = `${e.status}\u0001${e.e}`;
      const x = errors.get(k);
      if (x) x.n += e.n;
      else errors.set(k, { status: e.status, e: e.e, n: e.n });
    }
    for (const h of p.hist.values()) {
      if (!keeps(s, h.provider, h.share)) continue;
      for (let b = 0; b < BUCKETS; b++) {
        dur[b]! += h.dur[b]!;
        ttft[b]! += h.ttft[b]!;
      }
    }
  }
  // The period right before this one, same length, for the "vs previous" deltas.
  const exact = s.until - s.since <= 3 * HOUR;
  const start = exact ? s.since : firstHour;
  const prev = { n: 0, err: 0, i: 0, c: 0, o: 0, d: 0 };
  for (const p of collect(db, start - (s.until - start), start - 1)) {
    for (const g of p.groups.values()) {
      if (!keeps(s, g.provider, g.account?.startsWith("share:") ?? false)) continue;
      prev.n += g.n; prev.err += g.err; prev.i += g.i; prev.c += g.c; prev.o += g.o; prev.d += g.d;
    }
  }
  return {
    groups: [...groups.values()],
    hourly: [...hourly.values()].sort((a, b) => a.t - b.t),
    errors: [...errors.values()].sort((a, b) => b.n - a.n).slice(0, 300),
    durHist: toRows(dur),
    ttftHist: toRows(ttft),
    prev: prev.n > 0 ? prev : null,
  };
}

/** Error rows -> counts per kind (uses the shared classifier so it matches the log page). */
export function errorKindCounts(rows: Array<{ status: number; e: string | null; n: number }>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rows) {
    const k = errorKind(r.status, r.e);
    out[k] = (out[k] ?? 0) + r.n;
  }
  return out;
}

// ---------------------------------------------------------------------------
// share users (list): reduced inside the worker so only small rows cross the thread boundary
// ---------------------------------------------------------------------------

export interface ShareUsersParams {
  since: number;
  until: number;
  /** Local-time offset used to cut days, so "active days" match the operator's calendar. */
  tzOffsetMs: number;
}

export interface ShareUserRaw {
  a: string;
  n: number;
  err: number;
  i: number;
  c: number;
  o: number;
  r: number;
  d: number;
  first: number;
  last: number;
  ips: number;
  devs: number;
  days: Array<[number, number]>;
  models: Array<[string, number]>;
  efforts: Array<[string | null, number]>;
}

export function shareUsersRaw(db: Database, p: ShareUsersParams): ShareUserRaw[] {
  interface Acc {
    row: ShareUserRaw;
    days: Map<number, number>;
    models: Map<string, number>;
    efforts: Map<string, number>;
    ips: Set<string>;
    devs: Set<string>;
  }
  const users = new Map<string, Acc>();
  for (const part of collect(db, p.since, p.until)) {
    const day = Math.floor((part.from + p.tzOffsetMs) / DAY);
    for (const g of part.groups.values()) {
      if (!g.account || !g.account.startsWith("share:")) continue;
      let u = users.get(g.account);
      if (!u) {
        u = {
          row: { a: g.account, n: 0, err: 0, i: 0, c: 0, o: 0, r: 0, d: 0, first: g.first, last: g.last, ips: 0, devs: 0, days: [], models: [], efforts: [] },
          days: new Map(),
          models: new Map(),
          efforts: new Map(),
          ips: new Set(),
          devs: new Set(),
        };
        users.set(g.account, u);
      }
      const r = u.row;
      r.n += g.n; r.err += g.err; r.i += g.i; r.c += g.c; r.o += g.o; r.r += g.r; r.d += g.d;
      if (g.first < r.first) r.first = g.first;
      if (g.last > r.last) r.last = g.last;
      u.days.set(day, (u.days.get(day) ?? 0) + g.n);
      u.models.set(g.model, (u.models.get(g.model) ?? 0) + g.n);
      const ek = g.effort ?? "";
      u.efforts.set(ek, (u.efforts.get(ek) ?? 0) + g.n);
    }
    for (const [acct, ids] of part.ids) {
      const u = users.get(acct);
      if (!u) continue;
      for (const x of ids.ips) u.ips.add(x);
      for (const x of ids.devs) u.devs.add(x);
    }
  }
  return [...users.values()].map((u) => ({
    ...u.row,
    ips: u.ips.size,
    devs: u.devs.size,
    days: [...u.days],
    models: [...u.models].sort((a, b) => b[1] - a[1]).slice(0, 5),
    efforts: [...u.efforts].map(([e, n]) => [e === "" ? null : e, n] as [string | null, number]).sort((a, b) => b[1] - a[1]).slice(0, 3),
  }));
}

/** Distinct (requested_model, provider) over a window, from the cached hours. */
export function distinctModels(db: Database, p: { since: number; until: number }): Array<{ m: string; provider: string }> {
  const seen = new Map<string, { m: string; provider: string }>();
  for (const part of collect(db, p.since, p.until)) for (const g of part.groups.values()) seen.set(`${g.provider}\u0001${g.model}`, { m: g.model, provider: g.provider });
  return [...seen.values()];
}
