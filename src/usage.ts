import { getDb } from "./store/db.ts";
import { protectText, unprotectText } from "./crypto/dpapi.ts";
import { resolveAlias } from "./store/modelmap.ts";
import { route } from "./router.ts";
import { providers } from "./providers/index.ts";
import type { CatalogModel, ProviderId, RequestOutcome } from "./types.ts";
import { listShareUsers } from "./share/users.ts";
import { stat } from "./stats/client.ts";
import { errorKindCounts, percentile, type RequestRowRaw, type RequestsFilter } from "./stats/queries.ts";
import { errorKind, type ErrorKind } from "./lib/error-kind.ts";
import { redact } from "./lib/log.ts";
import { EXACT_MAX_MS, HOUR } from "./stats/parts.ts";

export interface UsageRecord extends RequestOutcome {
  provider: ProviderId;
  requestedModel: string;
  effort?: string;
  startedAt: number;
  /** Share endpoint only: trimmed User-Agent and salted hashes (never raw IPs or ids). */
  client?: string | null;
  sessionKey?: string | null;
  ipHash?: string | null;
  device?: string | null;
}

export function recordUsage(r: UsageRecord): void {
  getDb()
    .query(
      `INSERT INTO usage(ts, provider, account_id, model, requested_model, status, duration_ms, first_token_ms,
        input_tokens, cached_tokens, output_tokens, reasoning_tokens, effort, error, client, session_key, ip_hash, device)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      r.startedAt,
      r.provider,
      r.accountId,
      r.servedModel ? protectText(r.servedModel) : "",
      r.requestedModel,
      r.status,
      Date.now() - r.startedAt,
      r.firstTokenMs ?? null,
      r.usage?.inputTokens ?? 0,
      r.usage?.cachedInputTokens ?? 0,
      r.usage?.outputTokens ?? 0,
      r.usage?.reasoningOutputTokens ?? 0,
      r.effort ?? null,
      r.error ?? null,
      r.client ?? null,
      r.sessionKey ?? null,
      r.ipHash ?? null,
      r.device ?? null,
    );
}

export interface UsageQuery {
  since: number;
  until?: number;
  provider?: string;
  source?: "pool" | "share";
}

// Catalog slug / wire model -> display name, for readable usage rows.
// Keyed by provider too: the same wire id (e.g. "gpt-6-sol") can exist on
// several providers, so a bare wire key would collide.
let displayMap: Map<string, string> | null = null;
async function modelDisplayMap(): Promise<Map<string, string>> {
  if (displayMap) return displayMap;
  const map = new Map<string, string>();
  for (const id of Object.keys(providers) as ProviderId[]) {
    const models = await providers[id].models().catch(() => [] as CatalogModel[]);
    for (const m of models) {
      map.set(`${id}|${m.slug}`, m.displayName);
      map.set(`${id}|${route(m.slug).model}`, m.displayName);
    }
  }
  displayMap = map;
  return map;
}

export function displayModel(map: Map<string, string>, provider: string, requested: string): string {
  const alias = resolveAlias(requested);
  if (alias) return map.get(`${alias.provider}|${alias.wire}`) ?? alias.wire;
  // Trust the row's own provider first — a bare wire id like "gpt-6-sol" would
  // route to chatgpt even when the row belongs to another provider.
  const byRow = map.get(`${provider}|${requested}`);
  if (byRow) return byRow;
  const r = route(requested);
  return map.get(`${r.provider}|${r.model}`) ?? requested;
}

export { modelDisplayMap };

/**
 * Share-mode rows carry `share:<email>` instead of a pool account id: resolve them to the
 * user's note (or email). Users removed since still show their email.
 */
export function shareNames(): (accountId: string | null) => string | null {
  let map: Map<string, string> | null = null;
  return (accountId) => {
    if (!accountId?.startsWith("share:")) return null;
    map ??= new Map(listShareUsers().map((u) => [u.email, u.label || u.email]));
    const email = accountId.slice("share:".length);
    return map.get(email) ?? email;
  };
}

// ---------------------------------------------------------------------------
// time windows: quantized so repeated polls share one cached computation
// ---------------------------------------------------------------------------

export const SPAN_MAX_MS = 90 * 86400_000;

/**
 * Snap a window to a grid (30 s for day-sized windows, 5 min above) and pick its cache TTL.
 * Windows longer than a few hours are answered from whole cached hours, so `since` is floored to
 * the hour here: the range reported back is exactly the range that was counted.
 */
export function quantizeWindow(since: number, until: number): { since: number; until: number; ttl: number } {
  const span = Math.max(60_000, Math.min(SPAN_MAX_MS, until - since));
  const short = span <= 26 * 3600_000;
  const step = short ? 30_000 : 300_000;
  // Round `until` up: a request recorded a second ago must already count.
  const u = Math.ceil(until / step) * step;
  let s = u - Math.floor(span / step) * step;
  if (u - s > EXACT_MAX_MS) {
    s = Math.floor(s / HOUR) * HOUR;
    if (u - s > SPAN_MAX_MS) s += HOUR; // flooring must not push a 90-day window past 90 days
  }
  return { since: s, until: u, ttl: short ? 20_000 : 120_000 };
}

// ---------------------------------------------------------------------------
// overview
// ---------------------------------------------------------------------------

const DAY = 86400_000;

interface ModelAgg {
  model: string;
  provider: string;
  requests: number;
  errors: number;
  input: number;
  cached: number;
  output: number;
  reasoning: number;
}

/** Totals + breakdowns for the dashboard. */
export async function usageSummary(q: UsageQuery) {
  const w = quantizeWindow(q.since, q.until ?? Date.now());
  const scope = { since: w.since, until: w.until, provider: q.provider, source: q.source };
  const raw = await stat("overview", scope, w.ttl);
  const g = raw.groups;

  let n = 0, err = 0, i = 0, c = 0, o = 0, r = 0, d = 0, ft = 0, ftn = 0, tpsOut = 0, tpsMs = 0;
  const byModelMap = new Map<string, ModelAgg>();
  const byAcct = new Map<string, { accountId: string | null; provider: string; requests: number; errors: number; input: number; cached: number; output: number; ms: number }>();
  const byEffort = new Map<string, { effort: string | null; requests: number; output: number; reasoning: number }>();
  const sources = { pool: { requests: 0, errors: 0, tokens: 0 }, share: { requests: 0, errors: 0, tokens: 0 } };
  for (const x of g) {
    n += x.n; err += x.err; i += x.i; c += x.c; o += x.o; r += x.r; d += x.d; ft += x.ft; ftn += x.ftn;
    tpsOut += x.tpsOut; tpsMs += x.tpsMs;
    const mk = `${x.provider}|${x.model}`;
    const m = byModelMap.get(mk) ?? { model: x.model, provider: x.provider, requests: 0, errors: 0, input: 0, cached: 0, output: 0, reasoning: 0 };
    m.requests += x.n; m.errors += x.err; m.input += x.i; m.cached += x.c; m.output += x.o; m.reasoning += x.r;
    byModelMap.set(mk, m);
    const ak = `${x.account_id ?? ""}|${x.provider}`;
    const a = byAcct.get(ak) ?? { accountId: x.account_id, provider: x.provider, requests: 0, errors: 0, input: 0, cached: 0, output: 0, ms: 0 };
    a.requests += x.n; a.errors += x.err; a.input += x.i; a.cached += x.c; a.output += x.o; a.ms += x.d;
    byAcct.set(ak, a);
    const ek = x.effort ?? "";
    const e = byEffort.get(ek) ?? { effort: x.effort, requests: 0, output: 0, reasoning: 0 };
    e.requests += x.n; e.output += x.o; e.reasoning += x.r;
    byEffort.set(ek, e);
    const src = x.account_id?.startsWith("share:") ? sources.share : sources.pool;
    src.requests += x.n; src.errors += x.err; src.tokens += x.i + x.o;
  }

  const names = await modelDisplayMap();
  // Several requested slugs (alias, openai/..., bare) can share one display name: merge them.
  const merged = new Map<string, ModelAgg>();
  for (const m of byModelMap.values()) {
    const shown = { ...m, model: displayModel(names, m.provider, m.model) };
    const key = `${shown.provider}|${shown.model}`;
    const hit = merged.get(key);
    if (!hit) {
      merged.set(key, shown);
      continue;
    }
    hit.requests += shown.requests; hit.errors += shown.errors; hit.input += shown.input;
    hit.cached += shown.cached; hit.output += shown.output; hit.reasoning += shown.reasoning;
  }
  const byModel = [...merged.values()].sort((a, b) => b.requests - a.requests);

  // Labels only: never decrypt credentials just to name a row.
  const accounts = new Map(
    (getDb().query("SELECT id, label, email FROM accounts").all() as Array<{ id: string; label: string; email: string | null }>).map((a) => [a.id, a]),
  );
  const shareName = shareNames();
  const byAccount = [...byAcct.values()]
    .sort((a, b) => b.requests - a.requests)
    .slice(0, 100)
    .map((a) => {
      const acc = a.accountId ? accounts.get(a.accountId) : undefined;
      const share = shareName(a.accountId);
      return {
        accountId: a.accountId,
        label: share ?? acc?.label ?? null,
        email: share ? a.accountId!.slice("share:".length) : (acc?.email ?? null),
        provider: a.provider,
        requests: a.requests,
        input: a.input,
        cached: a.cached,
        output: a.output,
        errors: a.errors,
        avgMs: a.requests ? a.ms / a.requests : 0,
        ...(share ? { shared: true } : {}),
      };
    });

  const durHist = raw.durHist;
  const ttftHist = raw.ttftHist;
  // Legacy bucketed timeline (hourly up to 2 days, else UTC days) for older clients.
  const bucket = w.until - w.since <= 2 * DAY ? 3600_000 : DAY;
  const tl = new Map<number, { t: number; requests: number; input: number; output: number }>();
  for (const h of raw.hourly) {
    const t = Math.floor(h.t / bucket) * bucket;
    const x = tl.get(t) ?? { t, requests: 0, input: 0, output: 0 };
    x.requests += h.n; x.input += h.i; x.output += h.o;
    tl.set(t, x);
  }

  return {
    range: { since: w.since, until: w.until },
    totals: {
      requests: n, errors: err, input: i, cached: c, output: o, reasoning: r,
      avgMs: n ? d / n : 0,
      avgFirstTokenMs: ftn ? ft / ftn : null,
    },
    prev: raw.prev
      ? { requests: raw.prev.n, errors: raw.prev.err, input: raw.prev.i, cached: raw.prev.c, output: raw.prev.o, avgMs: raw.prev.d / raw.prev.n }
      : null,
    latency: {
      p50: percentile(durHist, 0.5), p95: percentile(durHist, 0.95), p99: percentile(durHist, 0.99),
      ttftP50: percentile(ttftHist, 0.5), ttftP95: percentile(ttftHist, 0.95), ttftP99: percentile(ttftHist, 0.99),
    },
    tokensPerSec: tpsMs > 0 ? tpsOut / (tpsMs / 1000) : null,
    byModel,
    byAccount,
    accountsTotal: byAcct.size,
    byEffort: [...byEffort.values()].sort((a, b) => b.requests - a.requests),
    errorKinds: errorKindCounts(raw.errors),
    sources,
    hourly: raw.hourly.map((h) => ({ t: h.t, requests: h.n, errors: h.err, input: h.i, output: h.o })),
    timeline: [...tl.values()].sort((a, b) => a.t - b.t),
    bucketMs: bucket,
  };
}

// ---------------------------------------------------------------------------
// request log
// ---------------------------------------------------------------------------

export interface RequestsQuery {
  limit?: number;
  before?: number;
  provider?: string;
  source?: "pool" | "share";
  account?: string;
  status?: "ok" | "err";
  /** Display name as shown in the log ("GPT-6 Astra"); resolved to the slugs stored in the table. */
  model?: string;
  effort?: string;
  minMs?: number;
  q?: string;
}

export interface RequestRow extends Omit<RequestRowRaw, "sessionKey" | "ipHash" | "device"> {
  shared?: boolean;
  kind: ErrorKind;
  /** Short tags so rows can be grouped by conversation / network / machine; the hashes stay server-side. */
  session: string | null;
  ip: string | null;
  device: string | null;
}

async function resolveModels(display: string, names: Map<string, string>): Promise<string[]> {
  const until = Math.ceil(Date.now() / 3600_000) * 3600_000;
  const seen = await stat("models", { since: until - 7 * DAY, until }, 10 * 60_000);
  return [...new Set(seen.filter((r) => displayModel(names, r.provider, r.m) === display).map((r) => r.m))];
}

export async function queryRequests(q: RequestsQuery = {}): Promise<RequestRow[]> {
  const names = await modelDisplayMap();
  const f: RequestsFilter = {
    limit: Math.max(1, Math.min(500, q.limit ?? 100)),
    before: q.before,
    provider: q.provider,
    source: q.source,
    account: q.account,
    status: q.status,
    effort: q.effort,
    minMs: q.minMs,
    q: q.q,
    models: q.model ? await resolveModels(q.model, names) : undefined,
  };
  const rows = await stat("requests", f, 2000);
  const shareName = shareNames();
  return rows.map((r) => {
    const name = shareName(r.accountId);
    const { sessionKey, ipHash, device, error, ...rest } = r;
    return {
      ...rest,
      error: error ? redact(error) : error,
      model: displayModel(names, r.provider, unprotectText(r.model)),
      requestedModel: displayModel(names, r.provider, r.requestedModel),
      accountLabel: name ?? r.accountLabel,
      ...(name ? { shared: true } : {}),
      kind: errorKind(r.status, error),
      session: sessionKey ? sessionKey.slice(0, 8) : null,
      ip: ipHash ? ipHash.slice(0, 6) : null,
      device: device ? device.slice(0, 6) : null,
    };
  });
}

export async function recentRequests(limit = 100) {
  return queryRequests({ limit });
}
