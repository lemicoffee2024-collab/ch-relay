import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDb, useMemoryDb } from "../src/store/db.ts";
import { protectText } from "../src/crypto/dpapi.ts";
import { upsertAccount } from "../src/store/accounts.ts";
import { handleApi } from "../src/api.ts";
import { queryRequests, quantizeWindow, usageSummary } from "../src/usage.ts";
import { shareStats, shareUserStats } from "../src/share/stats.ts";
import { addShareUser } from "../src/share/users.ts";
import { errorKind } from "../src/lib/error-kind.ts";
import { bucketOf, cachedHours, clearParts, collect, HOUR, setPartBudgetForTests } from "../src/stats/parts.ts";
import { bucketMid } from "../src/stats/overview.ts";
import { resetStats, setStatsPathForTests, stat } from "../src/stats/client.ts";
import {
  clientInfo,
  flushShareEvents,
  listShareEvents,
  listShareQuotas,
  purgeShareEvents,
  recordShareEvent,
  resetShareTelemetry,
  saveShareQuota,
  shareEventCounts,
} from "../src/share/telemetry.ts";

const DAY = 24 * HOUR;

beforeEach(() => {
  useMemoryDb();
  resetStats();
  resetShareTelemetry();
});
afterEach(() => setStatsPathForTests(undefined));

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

interface Ins {
  ts: number;
  provider?: string;
  account?: string | null;
  model?: string;
  status?: number;
  dur?: number;
  ft?: number | null;
  i?: number;
  c?: number;
  o?: number;
  r?: number;
  effort?: string | null;
  error?: string | null;
  client?: string | null;
  sess?: string | null;
  ip?: string | null;
  device?: string | null;
}

function ins(x: Ins): void {
  getDb()
    .query(
      `INSERT INTO usage(ts, provider, account_id, model, requested_model, status, duration_ms, first_token_ms, input_tokens, cached_tokens,
        output_tokens, reasoning_tokens, effort, error, client, session_key, ip_hash, device) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      x.ts,
      x.provider ?? "chatgpt",
      x.account === undefined ? null : x.account,
      protectText("served"),
      x.model ?? "gpt-x",
      x.status ?? 200,
      x.dur ?? 1000,
      x.ft === undefined ? 400 : x.ft,
      x.i ?? 100,
      x.c ?? 40,
      x.o ?? 20,
      x.r ?? 5,
      x.effort === undefined ? "high" : x.effort,
      x.error ?? null,
      x.client ?? null,
      x.sess ?? null,
      x.ip ?? null,
      x.device ?? null,
    );
}

/** Deterministic pseudo-random numbers so a failure reproduces. */
function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ERRORS = [
  { status: 200, error: "response.failed: server is overloaded" },
  { status: 429, error: "rate limit reached" },
  { status: 200, error: "stream error: socket closed" },
  { status: 499, error: "client cancelled" },
  { status: 400, error: "model not supported" },
  { status: 401, error: null },
];

type SeedRow = Required<Pick<Ins, "ts" | "account" | "provider" | "model" | "effort" | "status" | "dur" | "ft" | "i" | "c" | "o" | "r">> & { error: string | null };

function seed(now: number, n = 400) {
  const rand = rng(7);
  const accounts = ["acc1", "acc2", "share:a@x.com", "share:b@x.com", null];
  const models = ["gpt-x", "gpt-y"];
  const efforts = ["low", "high", null];
  const rows: SeedRow[] = [];
  for (let k = 0; k < n; k++) {
    const failed = rand() < 0.15;
    const e = failed ? ERRORS[Math.floor(rand() * ERRORS.length)]! : { status: 200, error: null };
    const row = {
      ts: now - Math.floor(rand() * 3 * DAY) - 45 * 60_000,
      account: accounts[Math.floor(rand() * accounts.length)]!,
      provider: rand() < 0.8 ? "chatgpt" : "antigravity",
      model: models[Math.floor(rand() * models.length)]!,
      effort: efforts[Math.floor(rand() * efforts.length)]!,
      status: e.status,
      error: e.error,
      dur: Math.floor(rand() * 60_000) + 50,
      ft: rand() < 0.9 ? Math.floor(rand() * 8000) : (null as unknown as number),
      i: Math.floor(rand() * 5000),
      c: Math.floor(rand() * 3000),
      o: Math.floor(rand() * 900),
      r: Math.floor(rand() * 300),
    };
    rows.push(row);
    ins(row);
  }
  return rows;
}

const near = (got: number | null, want: number) => {
  // histogram buckets are 20 ms / 100 ms / 1 s wide: accept one bucket of error
  const tol = want < 1000 ? 20 : want < 10_000 ? 100 : 1000;
  expect(got).not.toBeNull();
  expect(Math.abs(got! - want)).toBeLessThanOrEqual(tol);
};

const exactPercentile = (sorted: number[], p: number) => sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)]!;

// ---------------------------------------------------------------------------
// error classifier
// ---------------------------------------------------------------------------

test("errorKind: the same words the log page used, plus auth", () => {
  expect(errorKind(200, null)).toBe("ok");
  expect(errorKind(200, "response.failed: server is overloaded")).toBe("overload");
  expect(errorKind(200, "Rate limit reached")).toBe("rate");
  expect(errorKind(429, "whatever")).toBe("rate");
  expect(errorKind(429, null)).toBe("rate");
  expect(errorKind(200, "client cancelled")).toBe("cancel");
  expect(errorKind(499, null)).toBe("cancel");
  expect(errorKind(502, "network error: socket hang up")).toBe("network");
  expect(errorKind(200, "stream ended without response.completed")).toBe("network");
  expect(errorKind(400, "The model is not supported")).toBe("model");
  expect(errorKind(502, "upstream reported model gpt-9")).toBe("model");
  expect(errorKind(401, null)).toBe("auth");
  expect(errorKind(403, "forbidden")).toBe("auth");
  expect(errorKind(500, "boom")).toBe("other");
  expect(errorKind(500, null)).toBe("other");
});

// ---------------------------------------------------------------------------
// overview: the engine must agree with a brute-force pass over the same rows
// ---------------------------------------------------------------------------

test("overview totals, breakdowns, timeline and latency match a brute-force pass", async () => {
  const now = Date.now();
  const rows = seed(now);
  const s = await usageSummary({ since: now - 4 * DAY, until: now });
  const lo = Math.floor(s.range.since / HOUR) * HOUR;
  const mine = rows.filter((r) => r.ts >= lo && r.ts <= s.range.until);
  expect(mine.length).toBe(rows.length); // the whole seed sits inside the window

  const failed = (r: (typeof rows)[number]) => r.status >= 400 || !!r.error;
  expect(s.totals.requests).toBe(mine.length);
  expect(s.totals.errors).toBe(mine.filter(failed).length);
  expect(s.totals.input).toBe(mine.reduce((a, r) => a + r.i, 0));
  expect(s.totals.cached).toBe(mine.reduce((a, r) => a + r.c, 0));
  expect(s.totals.output).toBe(mine.reduce((a, r) => a + r.o, 0));
  expect(s.totals.reasoning).toBe(mine.reduce((a, r) => a + r.r, 0));
  expect(s.totals.avgMs).toBeCloseTo(mine.reduce((a, r) => a + r.dur, 0) / mine.length, 6);

  // hourly points add up to the same total, and errors per hour do too
  expect(s.hourly.reduce((a, h) => a + h.requests, 0)).toBe(mine.length);
  expect(s.hourly.reduce((a, h) => a + h.errors, 0)).toBe(mine.filter(failed).length);
  expect(s.hourly.every((h) => h.t % HOUR === 0)).toBe(true);

  // sources and effort
  const shareRows = mine.filter((r) => r.account?.startsWith("share:"));
  expect(s.sources.share.requests).toBe(shareRows.length);
  expect(s.sources.pool.requests).toBe(mine.length - shareRows.length);
  for (const e of s.byEffort) expect(e.requests).toBe(mine.filter((r) => (r.effort ?? null) === e.effort).length);

  // error kinds add up to the error count and match the classifier
  const kinds: Record<string, number> = {};
  for (const r of mine.filter(failed)) {
    const k = errorKind(r.status, r.error);
    kinds[k] = (kinds[k] ?? 0) + 1;
  }
  expect(s.errorKinds).toEqual(kinds);

  // latency percentiles come from OK rows only, within one histogram bucket
  const ok = mine.filter((r) => !failed(r)).map((r) => r.dur).sort((a, b) => a - b);
  near(s.latency.p50, exactPercentile(ok, 0.5));
  near(s.latency.p95, exactPercentile(ok, 0.95));
  near(s.latency.p99, exactPercentile(ok, 0.99));
  const ttft = mine.filter((r) => !failed(r) && r.ft != null).map((r) => r.ft as number).sort((a, b) => a - b);
  near(s.latency.ttftP50, exactPercentile(ttft, 0.5));

  // by account keeps pool and share rows apart and sorts by requests
  const top = s.byAccount[0]!;
  expect(top.requests).toBe(Math.max(...s.byAccount.map((a) => a.requests)));
  expect(s.byAccount.reduce((a, x) => a + x.requests, 0)).toBe(mine.length);
});

test("overview filters: provider and source narrow every figure", async () => {
  const now = Date.now();
  const rows = seed(now);
  const chat = await usageSummary({ since: now - 4 * DAY, until: now, provider: "chatgpt" });
  expect(chat.totals.requests).toBe(rows.filter((r) => r.provider === "chatgpt").length);
  expect(chat.byModel.every((m) => m.provider === "chatgpt")).toBe(true);
  const share = await usageSummary({ since: now - 4 * DAY, until: now, source: "share" });
  expect(share.totals.requests).toBe(rows.filter((r) => r.account?.startsWith("share:")).length);
  expect(share.sources.pool.requests).toBe(0);
  const pool = await usageSummary({ since: now - 4 * DAY, until: now, source: "pool" });
  expect(pool.totals.requests).toBe(rows.filter((r) => !r.account?.startsWith("share:")).length);
  expect(pool.hourly.reduce((a, h) => a + h.requests, 0)).toBe(pool.totals.requests);
});

test("overview: previous period is the same length right before, or null when empty", async () => {
  const now = Date.now();
  const w = quantizeWindow(now - 2 * DAY, now);
  const start = Math.floor(w.since / HOUR) * HOUR;
  const span = w.until - start;
  for (let k = 0; k < 6; k++) ins({ ts: start + 5 * HOUR + k * 1000, o: 10 });
  for (let k = 0; k < 4; k++) ins({ ts: start - span + 5 * HOUR + k * 1000, o: 10 });
  const s = await usageSummary({ since: now - 2 * DAY, until: now });
  expect(s.totals.requests).toBe(6);
  expect(s.prev?.requests).toBe(4);
  resetStats();
  getDb().query("DELETE FROM usage WHERE ts < ?").run(start);
  expect((await usageSummary({ since: now - 2 * DAY, until: now })).prev).toBeNull();
});

test("the range reported is the range counted: whole hours beyond 3 h, exact below", async () => {
  const now = Date.now();
  for (const span of [4 * HOUR, DAY, 7 * DAY, 30 * DAY]) {
    const w = quantizeWindow(now - span, now);
    expect(w.since % HOUR).toBe(0);
    expect(w.until - w.since).toBeGreaterThanOrEqual(span);
    expect(w.until - w.since).toBeLessThan(span + HOUR + 300_000);
    const s = await usageSummary({ since: now - span, until: now });
    expect(s.range).toEqual({ since: w.since, until: w.until });
    const u = await shareStats(now - span, now);
    expect(u.range.since % HOUR).toBe(0);
  }
  const short = quantizeWindow(now - HOUR, now);
  expect(short.until - short.since).toBe(HOUR); // exact: no rounding to whole hours
  // a request just outside the exact window is not counted, one just inside the whole-hour window is
  resetStats(); // the loop above cached this exact window
  const w24 = quantizeWindow(now - DAY, now);
  ins({ ts: w24.since - 5 * 60_000 });
  ins({ ts: w24.since + 5 * 60_000 });
  expect((await usageSummary({ since: now - DAY, until: now })).totals.requests).toBe(1);
});

test("a short window is scanned exactly, not rounded to whole hours", async () => {
  const now = Date.now();
  ins({ ts: now - 90 * 60_000 }); // 90 min ago: outside a 1 h window
  ins({ ts: now - 20 * 60_000 });
  ins({ ts: now - 5 * 60_000 });
  const s = await usageSummary({ since: now - HOUR, until: now });
  expect(s.totals.requests).toBe(2);
});

// ---------------------------------------------------------------------------
// hour cache
// ---------------------------------------------------------------------------

test("hour cache: closed hours are remembered, the open hour and late writes stay live", () => {
  const db = getDb();
  const H = Math.floor(Date.now() / HOUR) * HOUR - 6 * HOUR;
  ins({ ts: H + 10 });
  // 10 minutes after the hour ended: not closed yet, so a late write still counts
  let now = H + HOUR + 10 * 60_000;
  expect(collect(db, H - 4 * HOUR, H + 2 * HOUR, now).flatMap((p) => [...p.groups.values()]).reduce((a, g) => a + g.n, 0)).toBe(1);
  expect(cachedHours(db)).toBe(0);
  ins({ ts: H + 20 });
  expect(collect(db, H - 4 * HOUR, H + 2 * HOUR, now).flatMap((p) => [...p.groups.values()]).reduce((a, g) => a + g.n, 0)).toBe(2);
  // past the slack it is frozen in memory
  now = H + HOUR + 31 * 60_000;
  collect(db, H - 4 * HOUR, H + 2 * HOUR, now);
  expect(cachedHours(db)).toBe(1);
  ins({ ts: H + 30 });
  expect(collect(db, H - 4 * HOUR, H + 2 * HOUR, now).flatMap((p) => [...p.groups.values()]).reduce((a, g) => a + g.n, 0)).toBe(2);
  clearParts(db);
  expect(collect(db, H - 4 * HOUR, H + 2 * HOUR, now).flatMap((p) => [...p.groups.values()]).reduce((a, g) => a + g.n, 0)).toBe(3);
});

test("hour cache: a memory budget evicts the oldest hours first and answers stay correct", () => {
  const db = getDb();
  const base = Math.floor(Date.now() / HOUR) * HOUR - 12 * HOUR;
  for (let k = 0; k < 6; k++) for (let g = 0; g < 10; g++) ins({ ts: base + k * HOUR + g, account: `acc${g}` }); // 10 groups in each of 6 hours
  const total = (parts: ReturnType<typeof collect>) => parts.flatMap((p) => [...p.groups.values()]).reduce((a, g) => a + g.n, 0);
  try {
    setPartBudgetForTests(25); // room for two hours
    const now = Date.now();
    expect(total(collect(db, base, base + 6 * HOUR, now))).toBe(60);
    expect(cachedHours(db)).toBe(2);
    expect(total(collect(db, base, base + 6 * HOUR, now))).toBe(60); // evicted hours are recomputed, not lost
    setPartBudgetForTests(null);
    clearParts(db);
    collect(db, base, base + 6 * HOUR, now);
    expect(cachedHours(db)).toBe(6);
  } finally {
    setPartBudgetForTests(null);
  }
});

test("hour cache: hours with no rows cost nothing and never evict real ones", () => {
  const db = getDb();
  const H = Math.floor(Date.now() / HOUR) * HOUR - 10 * HOUR;
  ins({ ts: H + 5 });
  const now = Date.now();
  collect(db, now - 60 * DAY, now); // ~1440 hours, one with data
  expect(cachedHours(db)).toBe(1);
});

test("bucketOf and bucketMid agree: a value lands within one bucket of its midpoint", () => {
  for (const ms of [0, 19, 20, 999, 1000, 1099, 5000, 9999, 10_000, 45_500, 200_000, 500_000]) {
    const mid = bucketMid(bucketOf(ms));
    const tol = ms < 1000 ? 20 : ms < 10_000 ? 100 : 1000;
    expect(Math.abs(mid - Math.min(ms, 410_000))).toBeLessThanOrEqual(tol);
  }
});

// ---------------------------------------------------------------------------
// the stat() wrapper: worker thread, cache, fallback
// ---------------------------------------------------------------------------

test("stat: a real worker thread gives the same answer as running inline", async () => {
  const now = Date.now();
  seed(now, 120);
  const dir = mkdtempSync(join(tmpdir(), "ch-stats-"));
  const file = join(dir, "t.sqlite");
  try {
    getDb().exec(`VACUUM INTO '${file.replace(/\\/g, "/")}'`);
    const scope = { since: now - 4 * DAY, until: Math.ceil(now / 300_000) * 300_000 };
    const inline = await stat("overview", scope, 0);
    resetStats();
    setStatsPathForTests(file);
    const threaded = await stat("overview", scope, 0);
    expect(threaded).toEqual(inline);
    expect(threaded.groups.length).toBeGreaterThan(0);
  } finally {
    resetStats();
    setStatsPathForTests(undefined);
    await Bun.sleep(150); // Windows keeps the file locked until the worker thread is gone
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch {
      /* temp dir: best effort */
    }
  }
});

test("stat: an unusable worker path falls back to inline instead of failing", async () => {
  const now = Date.now();
  ins({ ts: now - 1000 });
  setStatsPathForTests(join(tmpdir(), "definitely-not-here", "x.sqlite"));
  const r = await stat("overview", { since: now - 4 * DAY, until: now }, 0);
  expect(r.groups.reduce((a, g) => a + g.n, 0)).toBe(1);
});

test("stat: results are cached for the TTL and shared by concurrent callers", async () => {
  const now = Date.now();
  ins({ ts: now - 1000 });
  const scope = { since: now - 4 * DAY, until: Math.ceil(now / 300_000) * 300_000 };
  const [a, b] = await Promise.all([stat("overview", scope, 60_000), stat("overview", scope, 60_000)]);
  expect(a).toBe(b); // same object: computed once
  ins({ ts: now - 500 });
  const again = await stat("overview", scope, 60_000);
  expect(again).toBe(a); // still cached
  const fresh = await stat("overview", scope, 0);
  expect(fresh.groups.reduce((s, g) => s + g.n, 0)).toBe(2);
});

// ---------------------------------------------------------------------------
// share users
// ---------------------------------------------------------------------------

function shareSeed(now: number) {
  addShareUser("busy@x.com", "Busy");
  addShareUser("quiet@x.com");
  addShareUser("soon@x.com", null, 24); // expires in 24 h
  addShareUser("erry@x.com");
  const t = now - 2 * HOUR;
  // busy: 60 ok requests over ~5 days on 3 devices, mixed models and efforts, a few slow ones
  for (let k = 0; k < 60; k++) {
    ins({
      ts: t - k * 2 * HOUR,
      account: "share:busy@x.com",
      model: k % 3 === 0 ? "gpt-y" : "gpt-x",
      effort: k % 2 ? "high" : "low",
      dur: 1000 + k * 100,
      i: 1000,
      o: 100,
      c: 500,
      device: `dev${k % 3}`,
      ip: `ip${k % 2}`,
      sess: `s${k % 5}`,
      client: "codex-test/1.0",
    });
  }
  // erry: 30 requests, 12 fail
  for (let k = 0; k < 30; k++) {
    const bad = k < 12;
    ins({ ts: t - k * HOUR, account: "share:erry@x.com", status: bad ? 200 : 200, error: bad ? "response.failed: server is overloaded" : null, i: 10, o: 1 });
  }
  // a removed user still has history
  ins({ ts: t, account: "share:gone@x.com", i: 5, o: 5 });
  // a pool request must never show up in the user stats
  ins({ ts: t, account: "acc1", i: 9999, o: 9999 });
}

test("shareStats: per-user figures, ranking, tags and summary", async () => {
  const now = Date.now();
  shareSeed(now);
  recordShareEvent("rate_limited", "busy@x.com", "h1");
  recordShareEvent("denied", "stranger@x.com", "h2", "not on allowlist");
  flushShareEvents();
  const s = await shareStats(now - 7 * DAY, now);
  const by = new Map(s.users.map((u) => [u.email, u]));

  const busy = by.get("busy@x.com")!;
  expect(busy.requests).toBe(60);
  expect(busy.tokens).toBe(60 * 1100);
  expect(busy.cacheRate).toBeCloseTo(0.5, 6);
  expect(busy.devices).toBe(3);
  expect(busy.ips).toBe(2);
  expect(busy.topModel).toBeTruthy();
  expect(busy.activeDays).toBeGreaterThanOrEqual(3);
  expect(busy.spark).toHaveLength(7);
  expect(busy.spark.reduce((a, b) => a + b, 0)).toBeGreaterThan(0);
  expect(busy.limitHits).toBe(1);
  expect(busy.tags).toContain("limited");
  expect(busy.tags).toContain("heavy");
  expect(busy.tags).toContain("multi");

  const erry = by.get("erry@x.com")!;
  expect(erry.errors).toBe(12);
  expect(erry.errorRate).toBeCloseTo(0.4, 6);
  expect(erry.tags).toContain("errors");
  expect(erry.advice).toContain("lỗi");

  const quiet = by.get("quiet@x.com")!;
  expect(quiet.requests).toBe(0);
  expect(quiet.tags).toContain("never"); // added, never connected, no requests
  expect(quiet.advice).toContain("Chưa từng kết nối");

  expect(by.get("soon@x.com")!.tags).toContain("expiring");
  const gone = by.get("gone@x.com")!;
  expect(gone.removed).toBe(true);
  expect(gone.tags).not.toContain("never");

  // ranking: by tokens, and the pool request is not counted anywhere
  expect(s.users[0]!.email).toBe("busy@x.com");
  expect(s.summary.tokens).toBe(60 * 1100 + 30 * 11 + 10);
  expect(s.summary.users).toBe(4);
  expect(s.summary.neverConnected).toBe(2); // quiet and soon: added, never connected, no requests
  expect(s.summary.expiringSoon).toBe(1);
  expect(s.summary.rateLimited24h).toBe(1);
  expect(s.summary.denied24h).toBe(1);
  expect(s.summary.top3Share).toBeGreaterThan(0.9);
  expect(s.events.map((e) => e.kind).sort()).toEqual(["denied", "rate_limited"]);
});

test("shareUserStats: one user's timeline, models, errors, recent rows and identity counts", async () => {
  const now = Date.now();
  shareSeed(now);
  const d = await shareUserStats("Busy@X.com", now - 7 * DAY, now);
  expect(d.email).toBe("busy@x.com");
  expect(d.label).toBe("Busy");
  expect(d.totals.requests).toBe(60);
  expect(d.totals.errors).toBe(0);
  expect(d.hourly.reduce((a, h) => a + h.requests, 0)).toBe(60);
  expect(d.byModel.reduce((a, m) => a + m.requests, 0)).toBe(60);
  expect(d.byEffort.reduce((a, e) => a + e.requests, 0)).toBe(60);
  expect(d.devices).toBe(3);
  expect(d.ips).toBe(2);
  expect(d.sessions).toBe(5);
  expect(d.clients[0]).toEqual({ client: "codex-test/1.0", n: 60 });
  expect(d.recent).toHaveLength(50);
  const ts = d.recent.map((r) => r.ts as number);
  expect([...ts].sort((a, b) => b - a)).toEqual(ts); // newest first
  expect(d.recent[0]!.session).toHaveLength(2); // hash prefix only, never the stored value

  const ok = Array.from({ length: 60 }, (_, k) => 1000 + k * 100).sort((a, b) => a - b);
  near(d.latency.p50, exactPercentile(ok, 0.5));
  near(d.latency.p95, exactPercentile(ok, 0.95));

  const e = await shareUserStats("erry@x.com", now - 7 * DAY, now);
  expect(e.errorKinds).toEqual({ overload: 12 });
  const nobody = await shareUserStats("nobody@x.com", now - 7 * DAY, now);
  expect(nobody.totals.requests).toBe(0);
  expect(nobody.removed).toBe(true);
  expect(nobody.recent).toEqual([]);
});

// ---------------------------------------------------------------------------
// request log
// ---------------------------------------------------------------------------

test("requests: filters, keyset pagination, LIKE escaping and hostile input", async () => {
  const now = Date.now();
  for (let k = 0; k < 40; k++) {
    ins({
      ts: now - k * 1000,
      account: k % 4 === 0 ? "share:busy@x.com" : "acc1",
      model: k % 2 ? "gpt-x" : "gpt-y",
      effort: k % 5 === 0 ? null : "high",
      dur: k * 1000,
      status: k % 10 === 0 ? 500 : 200,
      error: k % 10 === 0 ? "boom 100% failed_x" : null,
    });
  }
  const all = await queryRequests({ limit: 500 });
  expect(all).toHaveLength(40);
  expect(all.map((r) => r.id)).toEqual([...all.map((r) => r.id)].sort((a, b) => b - a));

  // keyset pagination: no gaps, no overlap
  const p1 = await queryRequests({ limit: 15 });
  const p2 = await queryRequests({ limit: 15, before: p1.at(-1)!.id });
  const p3 = await queryRequests({ limit: 15, before: p2.at(-1)!.id });
  expect([p1.length, p2.length, p3.length]).toEqual([15, 15, 10]);
  expect([...p1, ...p2, ...p3].map((r) => r.id)).toEqual(all.map((r) => r.id));

  expect((await queryRequests({ status: "err" })).length).toBe(4);
  expect((await queryRequests({ status: "ok" })).length).toBe(36);
  expect((await queryRequests({ source: "share" })).every((r) => r.shared)).toBe(true);
  expect((await queryRequests({ source: "share" })).length).toBe(10);
  expect((await queryRequests({ account: "share:busy@x.com" })).length).toBe(10);
  expect((await queryRequests({ effort: "none" })).length).toBe(8);
  expect((await queryRequests({ effort: "high" })).length).toBe(32);
  expect((await queryRequests({ minMs: 30_000 })).every((r) => r.durationMs >= 30_000)).toBe(true);
  expect((await queryRequests({ minMs: 30_000 })).length).toBe(10);

  // LIKE wildcards are literal: "%" only matches a real percent sign, "_" a real underscore
  expect((await queryRequests({ q: "100%" })).length).toBe(4);
  expect((await queryRequests({ q: "%" })).length).toBe(4);
  expect((await queryRequests({ q: "failed_x" })).length).toBe(4);
  expect((await queryRequests({ q: "failed%x" })).length).toBe(0);
  expect((await queryRequests({ q: "_oom" })).length).toBe(0);

  // hostile strings are bound as data: no error, no rows, table intact
  for (const evil of [`' OR 1=1 --`, `"; DROP TABLE usage; --`, "\\", "%_%"]) {
    expect(Array.isArray(await queryRequests({ q: evil, account: evil, effort: evil, model: evil }))).toBe(true);
  }
  expect((getDb().query("SELECT count(*) AS n FROM usage").get() as { n: number }).n).toBe(40);
});

test("requests: rows carry a kind and short tags, never the stored hashes or a decrypted secret", async () => {
  const now = Date.now();
  ins({ ts: now, account: "share:busy@x.com", status: 200, error: "response.failed: server is overloaded", sess: "a".repeat(16), ip: "b".repeat(12), device: "c".repeat(12), client: "codex/1" });
  const [r] = await queryRequests({});
  expect(r!.kind).toBe("overload");
  expect(r!.session).toBe("aaaaaaaa");
  expect(r!.ip).toBe("bbbbbb");
  expect(r!.device).toBe("cccccc");
  const json = JSON.stringify(r);
  expect(json).not.toContain("a".repeat(16));
  expect(json).not.toContain("b".repeat(12));
  expect(r).not.toHaveProperty("ipHash");
  expect(r).not.toHaveProperty("sessionKey");
});

// ---------------------------------------------------------------------------
// API: parameter handling and the read-only contract
// ---------------------------------------------------------------------------

const call = (path: string, init: RequestInit = {}) => handleApi(new Request(`http://127.0.0.1${path}`, init), new URL(`http://127.0.0.1${path}`));
const WRITE = { "x-ch-relay": "1", "content-type": "application/json" };

test("api: malformed query strings fall back to safe defaults instead of failing or widening", async () => {
  const now = Date.now();
  for (let k = 0; k < 5; k++) ins({ ts: now - k * 1000 });
  for (const q of ["limit=abc", "limit=-5", "limit=99999999999999999999", "before=NaN", "before=-1", "minMs=1e9", "status=drop", "source=x", "provider=nope"]) {
    const res = await call(`/api/requests?${q}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(await res.json())).toBe(true);
  }
  expect(((await (await call("/api/requests?limit=2")).json()) as unknown[]).length).toBe(2);
  expect(((await (await call("/api/requests?limit=0")).json()) as unknown[]).length).toBe(1); // clamped to at least 1

  for (const q of ["range=forever", "range=", "from=abc&to=def", "from=200&to=100", "from=0&to=99999999999999"]) {
    const res = await call(`/api/usage?${q}`);
    expect(res.status).toBe(200);
    const s = (await res.json()) as { range: { since: number; until: number } };
    expect(s.range.until - s.range.since).toBeLessThanOrEqual(90 * DAY);
  }
  expect((await call("/api/share/stats?range=zzz")).status).toBe(200);
  expect((await call("/api/share/events?limit=-3")).status).toBe(200);
});

// Every GET the API exposes. If you add a route, add it here: the remote "viewer" role is
// enforced upstream as "GET/HEAD only", so a GET must never write and never leak a secret.
const GET_ROUTES = [
  "/api/status",
  "/api/accounts",
  "/api/models",
  "/api/usage",
  "/api/usage?range=7d&source=share",
  "/api/usage?range=90d&provider=chatgpt",
  "/api/requests",
  "/api/requests?status=err&q=x&model=y&effort=high&minMs=5&account=share:a@x.com",
  "/api/share",
  "/api/share/stats",
  "/api/share/stats?range=30d",
  "/api/share/events",
  "/api/share/events?email=a@x.com",
  "/api/share/users/a@x.com/stats",
  "/api/share/users/a%40x.com/stats?range=7d",
  "/api/login/chatgpt/unknown",
];

const FINGERPRINT_TABLES = ["accounts", "cooldowns", "quota", "affinity", "usage", "settings", "model_alias", "share_users", "admin_users", "share_events", "share_quota"];
function fingerprint(): string {
  const d = getDb();
  return FINGERPRINT_TABLES.map((t) => `${t}:${JSON.stringify(d.query(`SELECT * FROM ${t} ORDER BY rowid`).all())}`).join("\n");
}

test("read-only contract: no GET route writes anything or leaks a credential", async () => {
  // Some GETs (models) may reach for the network with an account's token: record every outbound call.
  const outbound: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    outbound.push(`${typeof input === "string" ? input : input instanceof URL ? input.href : input.url} ${JSON.stringify(init?.headers ?? {})} ${String(init?.body ?? "")}`);
    return new Response("{}", { status: 500 });
  }) as typeof fetch;
  try {
    await readOnlyContract();
  } finally {
    globalThis.fetch = realFetch;
  }
  expect(outbound.filter((o) => o.includes("SECRET-CREDENTIAL")), "no GET sends a stored credential upstream").toEqual([]);
});

async function readOnlyContract(): Promise<void> {
  const now = Date.now();
  const SECRET = "SECRET-CREDENTIAL-abc123";
  upsertAccount({ provider: "chatgpt", label: "main", email: "o@x.com", credential: { access_token: SECRET, refresh_token: SECRET } });
  getDb().query("INSERT INTO admin_users(username, passhash, label, enabled, created_at) VALUES ('boss', ?, NULL, 1, ?)").run("$argon2id$v=19$SECRETHASH", now);
  shareSeed(now);
  seed(now, 60);
  recordShareEvent("denied", "stranger@x.com", "h", "not on allowlist");
  flushShareEvents();
  saveShareQuota("busy@x.com", { weeklyPercent: 41, plan: "plus" });

  const before = fingerprint();
  for (const path of GET_ROUTES) {
    const res = await call(path);
    const body = await res.text();
    expect(res.status, path).toBeLessThan(500);
    expect(body, path).not.toContain(SECRET);
    expect(body, path).not.toContain("SECRETHASH");
    expect(body, path).not.toContain("passhash");
    expect(body, path).not.toContain("credential");
    // hashes are stored, but only short tags ever leave the server
    expect(body, path).not.toMatch(/"(ipHash|ip_hash|sessionKey|session_key|passhash|credential)"/);
    resetStats(); // force every route to recompute, not to serve a cache
  }
  expect(fingerprint()).toBe(before);
}

test("read-only contract: the statistics routes accept GET only", async () => {
  const now = Date.now();
  shareSeed(now);
  const before = fingerprint();
  const paths = ["/api/usage", "/api/requests", "/api/share/stats", "/api/share/events", "/api/share/users/busy@x.com/stats"];
  for (const path of paths) {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const res = await call(path, { method, headers: WRITE, body: JSON.stringify({ enabled: false, expireHours: 1, email: "x@x.com", publicUrl: "http://evil.example" }) });
      expect(res.status, `${method} ${path}`).toBe(404);
    }
  }
  expect(fingerprint()).toBe(before);
  // and the stats path cannot be used to reach the user-management mutations
  const del = await call("/api/share/users/busy@x.com/stats", { method: "DELETE", headers: WRITE });
  expect(del.status).toBe(404);
  expect(getDb().query("SELECT count(*) AS n FROM share_users WHERE email = 'busy@x.com'").get()).toEqual({ n: 1 });
});

// ---------------------------------------------------------------------------
// telemetry
// ---------------------------------------------------------------------------

test("clientInfo: salted hashes, no raw IP or id ever leaves it, stable per input", () => {
  const h = new Headers({
    "x-forwarded-for": "203.0.113.9, 10.0.0.1",
    "x-codex-installation-id": "install-42",
    "user-agent": "codex_cli_rs/0.9 (Windows 10; x86_64)\u0007é",
  });
  const a = clientInfo(h, { sessionKey: "thread-abc" });
  const b = clientInfo(h, { sessionKey: "thread-abc" });
  expect(a).toEqual(b);
  const json = JSON.stringify(a);
  expect(json).not.toContain("203.0.113.9");
  expect(json).not.toContain("install-42");
  expect(json).not.toContain("thread-abc");
  expect(a.ipHash).toHaveLength(12);
  expect(a.device).toHaveLength(12);
  expect(a.sessionKey).toHaveLength(16);
  expect(a.client).toBe("codex_cli_rs/0.9 (Windows 10; x86_64)"); // control and non-ASCII characters dropped
  const other = clientInfo(new Headers({ "x-forwarded-for": "203.0.113.10" }));
  expect(other.ipHash).not.toBe(a.ipHash);
  expect(other.device).toBeNull();
  expect(clientInfo(new Headers({ "cf-connecting-ip": "198.51.100.1", "x-forwarded-for": "203.0.113.9" })).ipHash).not.toBe(a.ipHash); // cf header wins
  expect(clientInfo(new Headers()).ipHash).toBeNull();
  expect(clientInfo(new Headers({ "user-agent": "x".repeat(500) })).client).toHaveLength(80);
});

test("share events: deduped per (kind, email), capped, batched and purged", () => {
  for (let k = 0; k < 500; k++) recordShareEvent("rate_limited", "a@x.com", "h1");
  recordShareEvent("denied", "a@x.com", "h1", "not on allowlist");
  expect(listShareEvents({ limit: 10 })).toEqual([]); // nothing written until a flush
  flushShareEvents();
  const rows = listShareEvents({ limit: 10 });
  expect(rows).toHaveLength(2);
  expect(rows.find((r) => r.kind === "rate_limited")!.n).toBe(500);
  expect(shareEventCounts(0).total).toEqual({ rate_limited: 500, denied: 1 });
  expect(shareEventCounts(0).byEmail.get("a@x.com")).toEqual({ rate_limited: 500, denied: 1 });
  expect(listShareEvents({ limit: 10, email: "nobody@x.com" })).toEqual([]);

  // a flood of distinct identities cannot grow the table without bound
  resetShareTelemetry();
  getDb().exec("DELETE FROM share_events");
  for (let k = 0; k < 5000; k++) recordShareEvent("denied", `u${k}@x.com`, null);
  flushShareEvents();
  expect((getDb().query("SELECT count(*) AS n FROM share_events").get() as { n: number }).n).toBeLessThanOrEqual(200);
  for (let round = 0; round < 6; round++) {
    for (let k = 0; k < 200; k++) recordShareEvent("denied", `r${round}-${k}@x.com`, null);
    flushShareEvents();
  }
  expect((getDb().query("SELECT count(*) AS n FROM share_events").get() as { n: number }).n).toBeLessThanOrEqual(500); // per-hour ceiling

  // retention
  getDb().exec("DELETE FROM share_events");
  getDb().query("INSERT INTO share_events(ts, kind, email, n) VALUES (?, 'denied', 'old@x.com', 1), (?, 'denied', 'new@x.com', 1)").run(Date.now() - 31 * DAY, Date.now() - DAY);
  expect(purgeShareEvents()).toBe(1);
  expect(listShareEvents({ limit: 10 }).map((r) => r.email)).toEqual(["new@x.com"]);
});

test("share quota snapshot: numbers only, throttled, plan sanitized", () => {
  saveShareQuota("a@x.com", { shortPercent: 12.5, shortResetAt: 1_800_000_000_000, weeklyPercent: 40, weeklyResetAt: 1_800_500_000_000, plan: "plus" });
  const first = listShareQuotas().get("a@x.com")!;
  expect(first).toMatchObject({ shortPercent: 12.5, weeklyPercent: 40, plan: "plus" });
  // unchanged within 10 minutes and changed within a minute: both skipped
  saveShareQuota("a@x.com", { shortPercent: 12.5, weeklyPercent: 40, plan: "plus" });
  saveShareQuota("a@x.com", { shortPercent: 99, weeklyPercent: 99, plan: "plus" });
  expect(listShareQuotas().get("a@x.com")!.weeklyPercent).toBe(40);
  // hostile plan text is dropped, non-numbers never stored
  saveShareQuota("b@x.com", { weeklyPercent: 5, plan: "<script>alert(1)</script>" });
  saveShareQuota("c@x.com", { weeklyPercent: "5; DROP" as unknown as number });
  expect(listShareQuotas().get("b@x.com")!.plan).toBeNull();
  expect(listShareQuotas().get("c@x.com")!.weeklyPercent).toBeNull();
});
