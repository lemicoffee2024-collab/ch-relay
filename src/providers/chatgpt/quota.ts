// ChatGPT quota: x-codex-* response headers and the WHAM usage endpoint.

import { getQuota, setQuota } from "../../store/accounts.ts";
import { pinnedFetch } from "../../net/pin.ts";

export const WHAM_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";

export interface ChatgptQuota {
  shortPercent?: number;
  /** Epoch ms. */
  shortResetAt?: number;
  weeklyPercent?: number;
  weeklyResetAt?: number;
  plan?: string;
  email?: string;
}

function num(v: unknown): number | undefined {
  if (v === null || v === undefined || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function pct(v: unknown): number | undefined {
  const n = num(v);
  return n === undefined ? undefined : Math.max(0, Math.min(100, n));
}

/** Reset timestamps arrive in seconds (or ms); normalise to epoch ms. */
export function toEpochMs(v: unknown): number | undefined {
  const n = num(v);
  if (n === undefined || n <= 0) return undefined;
  return n < 1e10 ? Math.round(n * 1000) : Math.round(n);
}

/**
 * Parse x-codex-* quota headers. The primary window is the short (5h) one only when it
 * declares a sub-day duration; otherwise it is the weekly window.
 */
export function parseQuotaHeaders(h: Headers): ChatgptQuota | null {
  const pP = pct(h.get("x-codex-primary-used-percent"));
  const sP = pct(h.get("x-codex-secondary-used-percent"));
  const pR = toEpochMs(h.get("x-codex-primary-reset-at"));
  const sR = toEpochMs(h.get("x-codex-secondary-reset-at"));
  const pMin = num(h.get("x-codex-primary-window-minutes"));
  const q: ChatgptQuota = {};
  if (pMin !== undefined && pMin > 0 && pMin < 1440) {
    if (pP !== undefined) q.shortPercent = pP;
    if (pR !== undefined) q.shortResetAt = pR;
    if (sP !== undefined) q.weeklyPercent = sP;
    if (sR !== undefined) q.weeklyResetAt = sR;
  } else if (pP !== undefined) {
    q.weeklyPercent = pP;
    if (pR !== undefined) q.weeklyResetAt = pR;
  } else if (sP !== undefined) {
    q.weeklyPercent = sP;
    if (sR !== undefined) q.weeklyResetAt = sR;
  }
  const plan = h.get("x-codex-plan-type");
  if (plan) q.plan = plan;
  return q.shortPercent !== undefined || q.weeklyPercent !== undefined ? q : null;
}

/** Earliest future reset timestamp announced in the headers (epoch ms). */
export function earliestHeaderReset(h: Headers, now = Date.now()): number | undefined {
  const all = ["primary", "secondary", "tertiary"]
    .map((w) => toEpochMs(h.get(`x-codex-${w}-reset-at`)))
    .filter((x): x is number => x !== undefined && x > now);
  return all.length ? Math.min(...all) : undefined;
}

function storedQuota(accountId: string): ChatgptQuota {
  const cur = getQuota(accountId);
  if (!cur) return {};
  const { updatedAt: _u, ...rest } = cur;
  return rest as ChatgptQuota;
}

/** Merge a fresh reading into the stored snapshot (keeps plan/email and windows the reading lacks). */
export function mergeQuota(accountId: string, q: ChatgptQuota): void {
  const next: Record<string, unknown> = { ...storedQuota(accountId) };
  for (const [k, v] of Object.entries(q)) if (v !== undefined) next[k] = v;
  setQuota(accountId, next);
}

export function applyQuotaHeaders(accountId: string, h: Headers): void {
  const q = parseQuotaHeaders(h);
  if (q) mergeQuota(accountId, q);
}

/**
 * Pool usage score = max(short%, weekly%). Windows whose reset time has passed count as 0.
 * Unknown quota -> undefined (treated as headroom).
 */
export function usageScore(accountId: string, now = Date.now()): number | undefined {
  const q = storedQuota(accountId);
  const vals: number[] = [];
  const add = (p: unknown, reset: unknown) => {
    const v = num(p);
    if (v === undefined) return;
    const r = num(reset);
    vals.push(r !== undefined && r <= now ? 0 : v);
  };
  add(q.shortPercent, q.shortResetAt);
  add(q.weeklyPercent, q.weeklyResetAt);
  return vals.length ? Math.max(...vals) : undefined;
}

interface WhamWindow {
  used_percent?: number;
  reset_at?: number;
  reset_after_seconds?: number;
  limit_window_seconds?: number;
}

/** Parse the WHAM /usage payload. A window shorter than a day is the short window. */
export function parseWhamUsage(data: any, now = Date.now()): ChatgptQuota {
  const q: ChatgptQuota = {};
  if (typeof data?.plan_type === "string") q.plan = data.plan_type;
  if (typeof data?.email === "string") q.email = data.email.toLowerCase();
  const rl = data?.rate_limit ?? {};
  for (const w of [rl.primary_window, rl.secondary_window] as Array<WhamWindow | null | undefined>) {
    if (!w || typeof w !== "object") continue;
    const p = pct(w.used_percent);
    if (p === undefined) continue;
    const reset =
      toEpochMs(w.reset_at) ?? (num(w.reset_after_seconds) !== undefined ? now + num(w.reset_after_seconds)! * 1000 : undefined);
    const secs = num(w.limit_window_seconds);
    if (secs !== undefined && secs < 86400) {
      q.shortPercent = p;
      if (reset !== undefined) q.shortResetAt = reset;
    } else {
      q.weeklyPercent = p;
      if (reset !== undefined) q.weeklyResetAt = reset;
    }
  }
  return q;
}

export async function fetchWhamUsage(accessToken: string, chatgptAccountId: string | undefined): Promise<Response> {
  const headers: Record<string, string> = { authorization: `Bearer ${accessToken}`, accept: "application/json" };
  if (chatgptAccountId) headers["chatgpt-account-id"] = chatgptAccountId;
  return pinnedFetch(WHAM_USAGE_URL, { headers, signal: AbortSignal.timeout(8_000) });
}

