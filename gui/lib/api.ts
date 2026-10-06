// Thin client for the Code Hole management API. Every write carries `x-ch-relay: 1`.

import type { ErrorKind } from "../../src/lib/error-kind.ts";

export type { ErrorKind };
export type ProviderId = "chatgpt" | "antigravity" | "opencode-zen" | "opencode-go";

export interface Cooldown {
  scope: string;
  until: number;
  reason: string | null;
}

export interface PublicAccount {
  id: string;
  provider: ProviderId;
  label: string;
  email: string | null;
  meta: Record<string, unknown>;
  priority: number;
  enabled: boolean;
  status: "ok" | "needs_reauth" | "error";
  statusDetail: string | null;
  createdAt: number;
  updatedAt: number;
  cooldowns: Cooldown[];
  quota: (Record<string, unknown> & { updatedAt: number }) | null;
}

export interface Status {
  version: string;
  port: number;
  uptimeMs: number;
  providers: Array<{ id: ProviderId; accounts: number; enabled: number }>;
}

export interface CatalogModel {
  slug: string;
  displayName: string;
  provider: ProviderId;
  contextWindow: number;
  reasoningLevels: string[];
  defaultReasoning: string;
  inputModalities: Array<"text" | "image">;
  hidden?: boolean;
}

export interface UsageTotals {
  requests: number;
  errors: number | null;
  input: number;
  cached: number;
  output: number;
  reasoning: number;
  avgMs: number;
  avgFirstTokenMs: number | null;
}

export interface Latency {
  p50: number | null;
  p95: number | null;
  p99: number | null;
  ttftP50: number | null;
  ttftP95: number | null;
  ttftP99: number | null;
}

export interface HourPoint {
  t: number;
  requests: number;
  errors: number;
  input: number;
  output: number;
}

export interface UsageSummary {
  range: { since: number; until: number };
  totals: UsageTotals;
  /** The period of the same length right before this one; null when it had no traffic. */
  prev: { requests: number; errors: number; input: number; cached: number; output: number; avgMs: number } | null;
  latency: Latency;
  tokensPerSec: number | null;
  byModel: Array<{ model: string; provider: ProviderId; requests: number; errors: number; input: number; cached: number; output: number; reasoning: number }>;
  byAccount: Array<{
    accountId: string | null;
    label: string | null;
    email: string | null;
    provider: ProviderId;
    requests: number;
    input: number;
    cached: number;
    output: number;
    errors: number;
    avgMs: number;
    shared?: boolean;
  }>;
  accountsTotal: number;
  byEffort: Array<{ effort: string | null; requests: number; output: number; reasoning: number }>;
  errorKinds: Partial<Record<ErrorKind, number>>;
  sources: { pool: { requests: number; errors: number; tokens: number }; share: { requests: number; errors: number; tokens: number } };
  hourly: HourPoint[];
  timeline: Array<{ t: number; requests: number; input: number; output: number }>;
  bucketMs: number;
}

export interface RequestRow {
  id: number;
  ts: number;
  provider: ProviderId;
  accountId: string | null;
  accountLabel: string | null;
  /** Request from a share user (their own ChatGPT login), not a pool account. */
  shared?: boolean;
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
  kind: ErrorKind;
  client: string | null;
  /** Short tags (never the stored hashes): same tag means same conversation, network or machine. */
  session: string | null;
  ip: string | null;
  device: string | null;
}

/** A preset window, or an explicit one in epoch ms. */
export type RangeKey = "24h" | "7d" | "30d";
export type RangeSel = { key: RangeKey } | { key: "custom"; from: number; to: number };

export interface UsageFilter {
  provider?: ProviderId;
  source?: "pool" | "share";
}

export interface RequestFilter extends UsageFilter {
  limit?: number;
  before?: number;
  account?: string;
  status?: "ok" | "err";
  model?: string;
  effort?: string;
  minMs?: number;
  q?: string;
}

export type UserTag = "heavy" | "steady" | "idle" | "dormant" | "never" | "errors" | "limited" | "expiring" | "multi" | "new" | "denied";

export interface ShareQuota {
  shortPercent: number | null;
  shortResetAt: number | null;
  weeklyPercent: number | null;
  weeklyResetAt: number | null;
  plan: string | null;
  updatedAt: number;
}

export interface ShareEvent {
  id: number;
  ts: number;
  kind: "rate_limited" | "denied";
  email: string | null;
  detail: string | null;
  n: number;
}

export interface UserRow {
  email: string;
  label: string | null;
  enabled: boolean;
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
  advice: string | null;
}

export interface ShareStats {
  range: { since: number; until: number };
  summary: {
    users: number;
    enabled: number;
    active1h: number;
    active24h: number;
    active7d: number;
    neverConnected: number;
    expiringSoon: number;
    withRequests: number;
    requests: number;
    errors: number;
    tokens: number;
    top3Share: number;
    rateLimited24h: number;
    denied24h: number;
  };
  users: UserRow[];
  events: ShareEvent[];
}

export interface UserDetail {
  email: string;
  label: string | null;
  enabled: boolean;
  removed: boolean;
  createdAt: number | null;
  lastSeenAt: number | null;
  expiresAt: number | null;
  range: { since: number; until: number };
  totals: { requests: number; errors: number; input: number; cached: number; output: number; reasoning: number; errorRate: number; cacheRate: number; avgMs: number; avgFirstTokenMs: number | null };
  latency: { p50: number | null; p95: number | null; p99: number | null; ttftP50: number | null; ttftP95: number | null };
  hourly: HourPoint[];
  byModel: Array<{ model: string; requests: number; errors: number; input: number; output: number }>;
  byEffort: Array<{ effort: string | null; requests: number; output: number; reasoning: number }>;
  errorKinds: Partial<Record<ErrorKind, number>>;
  clients: Array<{ client: string; n: number }>;
  sessions: number;
  ips: number;
  devices: number;
  activeDays: number;
  firstAt: number | null;
  lastAt: number | null;
  events: ShareEvent[];
  quota: ShareQuota | null;
  recent: Array<{
    id: number;
    ts: number;
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
    kind: ErrorKind;
    client: string | null;
    session: string | null;
    ip: string | null;
    device: string | null;
  }>;
}

export interface LoginStart {
  loginId: string;
  authUrl?: string;
  userCode?: string;
  verificationUrl?: string;
}

export type LoginStatus =
  | { state: "pending" }
  | { state: "done"; accountId: string; email: string | null }
  | { state: "error"; message: string };

export interface SyncResult {
  catalogPath: string;
  configPath: string;
  models: number;
  backup: string | null;
}

export interface HarnessResult {
  id: "zcode" | "opencode" | "omp" | "pi";
  name: string;
  status: "synced" | "skipped" | "error";
  path: string;
  models?: number;
  backup?: string;
  message?: string;
}

export interface HarnessSyncResult {
  baseUrl: string;
  results: HarnessResult[];
}

export interface ShareUser {
  email: string;
  label: string | null;
  enabled: boolean;
  createdAt: number;
  lastSeenAt: number | null;
  /** Auto-removal time (epoch ms), counted from `createdAt`; null = never. */
  expiresAt: number | null;
  requests24h: number;
  tokens24h: number;
}

export interface ShareInfo {
  publicUrl: string | null;
  port: number | null;
  users: ShareUser[];
}

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const init: RequestInit = { method, headers: {} };
  if (method !== "GET") {
    init.headers = { "content-type": "application/json", "x-ch-relay": "1" };
    init.body = JSON.stringify(body ?? {});
  }
  let res: Response;
  try {
    res = await fetch(path, init);
  } catch {
    throw new ApiError("Không kết nối được tới Code Hole", 0);
  }
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (res.status === 401 && location.pathname !== "/login") location.href = "/login";
  if (!res.ok) {
    const msg =
      (data as { error?: { message?: string } } | null)?.error?.message ?? (text.slice(0, 200) || `HTTP ${res.status}`);
    throw new ApiError(msg, res.status);
  }
  return data as T;
}

const enc = encodeURIComponent;

/** Query string from defined values only. */
function qs(o: Record<string, string | number | undefined>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== "") p.set(k, String(v));
  return p.toString();
}

export function rangeParams(r: RangeSel): Record<string, string | number> {
  return r.key === "custom" ? { from: r.from, to: r.to } : { range: r.key };
}

export const api = {
  status: () => request<Status>("GET", "/api/status"),
  accounts: () => request<PublicAccount[]>("GET", "/api/accounts"),
  loginStart: (p: ProviderId, device = false) => request<LoginStart>("POST", `/api/accounts/${p}/login`, { device }),
  loginStatus: (p: ProviderId, id: string) => request<LoginStatus>("GET", `/api/login/${p}/${enc(id)}`),
  loginCancel: (p: ProviderId, id: string) => request<{ ok: boolean }>("DELETE", `/api/login/${p}/${enc(id)}`),
  addApiKey: (p: ProviderId, apiKey: string, label: string) =>
    request<PublicAccount>("POST", `/api/accounts/${p}/apikey`, { apiKey, label }),
  patchAccount: (id: string, patch: { label?: string; priority?: number; enabled?: boolean }) =>
    request<PublicAccount>("PATCH", `/api/accounts/${enc(id)}`, patch),
  deleteAccount: (id: string) => request<{ ok: boolean }>("DELETE", `/api/accounts/${enc(id)}`),
  refreshQuota: (id: string) => request<PublicAccount>("POST", `/api/accounts/${enc(id)}/quota`),
  clearCooldown: (id: string) => request<PublicAccount>("DELETE", `/api/accounts/${enc(id)}/cooldown`),
  models: () => request<CatalogModel[]>("GET", "/api/models"),
  sync: () => request<SyncResult>("POST", "/api/sync"),
  unsync: () => request<{ ok: boolean }>("DELETE", "/api/sync"),
  syncHarnesses: () => request<HarnessSyncResult>("POST", "/api/sync/harnesses"),
  usage: (range: RangeSel, f: UsageFilter = {}) => request<UsageSummary>("GET", `/api/usage?${qs({ ...rangeParams(range), ...f })}`),
  requests: (f: RequestFilter = {}) => request<RequestRow[]>("GET", `/api/requests?${qs({ limit: 100, ...f })}`),
  shareStats: (range: RangeSel) => request<ShareStats>("GET", `/api/share/stats?${qs(rangeParams(range))}`),
  shareUser: (email: string, range: RangeSel) => request<UserDetail>("GET", `/api/share/users/${enc(email)}/stats?${qs(rangeParams(range))}`),
  shareEvents: (limit = 50, email?: string) => request<ShareEvent[]>("GET", `/api/share/events?${qs({ limit, email })}`),
  share: () => request<ShareInfo>("GET", "/api/share"),
  shareSettings: (publicUrl: string | null) => request<{ ok: true }>("PUT", "/api/share/settings", { publicUrl }),
  addShareUser: (email: string, label?: string, expireHours?: number | null) =>
    request<{ ok: true }>("POST", "/api/share/users", { email, label, expireHours: expireHours ?? null }),
  patchShareUser: (email: string, patch: { enabled?: boolean; expireHours?: number | null }) =>
    request<{ ok: true }>("PATCH", `/api/share/users/${enc(email)}`, patch),
  deleteShareUser: (email: string) => request<{ ok: true }>("DELETE", `/api/share/users/${enc(email)}`),
};


export const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
