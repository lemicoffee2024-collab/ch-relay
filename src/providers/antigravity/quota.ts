// Quota snapshots (retrieveUserQuotaSummary, fallback fetchAvailableModels.quotaInfo).
import { getQuota, setQuota } from "../../store/accounts.ts";
import type { Account } from "../../types.ts";
import { DAILY_API, antigravityUserAgent, apiUrl } from "./constants.ts";
import { getAccessToken, getProjectId } from "./oauth.ts";

export type Family = "gem" | "cla";

export interface QuotaWindow {
  label: string;
  family: Family | null;
  window: "5h" | "weekly" | "other";
  remainingFraction: number;
  usedPercent: number;
  resetAt?: number;
}

export interface AgyQuota {
  source: "retrieveUserQuotaSummary" | "fetchAvailableModels";
  families: Partial<Record<Family, { remainingFraction: number; usedPercent: number; resetAt?: number }>>;
  windows: QuotaWindow[];
}

function num(v: unknown): number | undefined {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : undefined;
}

function remainingOf(rec: Record<string, unknown>): number | undefined {
  const target = (rec.remaining && typeof rec.remaining === "object" ? rec.remaining : rec) as Record<string, unknown>;
  const frac = num(target.remainingFraction);
  if (frac !== undefined) return Math.max(0, Math.min(1, frac));
  const pct = num(target.remainingPercentage);
  if (pct !== undefined) return Math.max(0, Math.min(1, pct > 1 ? pct / 100 : pct));
  return undefined;
}

function resetOf(v: unknown): number | undefined {
  if (typeof v === "string") {
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : undefined;
  }
  const n = num(v);
  if (n === undefined) return undefined;
  return n < 1e12 ? n * 1000 : n;
}

function familyOf(text: string): Family | null {
  const t = text.toLowerCase();
  if (t.includes("gemini")) return "gem";
  if (t.includes("claude") || t.includes("3p") || t.includes("gpt") || t.includes("opus") || t.includes("sonnet")) return "cla";
  return null;
}

function summarise(windows: QuotaWindow[], source: AgyQuota["source"]): AgyQuota | null {
  if (!windows.length) return null;
  const families: AgyQuota["families"] = {};
  for (const w of windows) {
    if (!w.family) continue;
    const cur = families[w.family];
    // Most restrictive window wins.
    if (!cur || w.remainingFraction < cur.remainingFraction) {
      families[w.family] = { remainingFraction: w.remainingFraction, usedPercent: w.usedPercent, ...(w.resetAt ? { resetAt: w.resetAt } : {}) };
    }
  }
  return { source, families, windows };
}

export function parseQuotaSummary(body: unknown): AgyQuota | null {
  const groups = Array.isArray((body as { groups?: unknown })?.groups) ? ((body as { groups: unknown[] }).groups) : [];
  const windows: QuotaWindow[] = [];
  for (const g of groups) {
    if (!g || typeof g !== "object") continue;
    const group = g as Record<string, unknown>;
    const name = `${String(group.displayName ?? "")} ${String(group.description ?? "")}`.trim();
    const family = familyOf(name);
    for (const b of Array.isArray(group.buckets) ? group.buckets : []) {
      if (!b || typeof b !== "object") continue;
      const bucket = b as Record<string, unknown>;
      const rem = remainingOf(bucket);
      if (rem === undefined) continue;
      const w = `${String(bucket.window ?? "")} ${String(bucket.bucketId ?? "")} ${String(bucket.displayName ?? "")}`.toLowerCase();
      const window = w.includes("week") ? "weekly" : w.includes("5h") || w.includes("five") ? "5h" : "other";
      windows.push({
        label: `${String(group.displayName ?? "").trim() || "Quota"}${window === "other" ? "" : ` (${window})`}`,
        family,
        window,
        remainingFraction: rem,
        usedPercent: Math.round((1 - rem) * 1000) / 10,
        ...(resetOf(bucket.resetTime) ? { resetAt: resetOf(bucket.resetTime) } : {}),
      });
    }
  }
  return summarise(windows, "retrieveUserQuotaSummary");
}

export function parseModelsQuota(body: unknown): AgyQuota | null {
  const models = (body as { models?: Record<string, unknown> } | null)?.models;
  if (!models || typeof models !== "object") return null;
  const windows: QuotaWindow[] = [];
  const seen = new Set<Family>();
  for (const [id, raw] of Object.entries(models)) {
    const info = (raw ?? {}) as Record<string, unknown>;
    const family = familyOf(`${id} ${String(info.displayName ?? "")}`);
    if (!family || seen.has(family)) continue;
    const qi = Array.isArray(info.quotaInfo) ? info.quotaInfo[0] : info.quotaInfo;
    if (!qi || typeof qi !== "object") continue;
    const rem = remainingOf(qi as Record<string, unknown>);
    if (rem === undefined) continue;
    seen.add(family);
    const resetAt = resetOf((qi as Record<string, unknown>).resetTime);
    windows.push({
      label: family === "gem" ? "Gemini" : "Claude / GPT-OSS",
      family,
      window: "other",
      remainingFraction: rem,
      usedPercent: Math.round((1 - rem) * 1000) / 10,
      ...(resetAt ? { resetAt } : {}),
    });
  }
  return summarise(windows, "fetchAvailableModels");
}

async function post(method: string, token: string, project: string): Promise<unknown> {
  const res = await fetch(apiUrl(DAILY_API, method), {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "User-Agent": antigravityUserAgent(),
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ project }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`Antigravity ${method} failed: ${res.status}`);
  return res.json();
}

export async function fetchAvailableModelsRaw(account: Account): Promise<unknown> {
  const token = await getAccessToken(account);
  const project = await getProjectId(account, token);
  return post("fetchAvailableModels", token, project);
}

export async function refreshAntigravityQuota(account: Account): Promise<void> {
  const token = await getAccessToken(account);
  const project = await getProjectId(account, token);
  let quota: AgyQuota | null = null;
  try {
    quota = parseQuotaSummary(await post("retrieveUserQuotaSummary", token, project));
  } catch {
    /* fall back below */
  }
  if (!quota) quota = parseModelsQuota(await post("fetchAvailableModels", token, project));
  if (!quota) throw new Error("Antigravity quota response had no usable windows");
  setQuota(account.id, quota as unknown as Record<string, unknown>);
}

/** Usage score (0..100, higher = more used) of an account for a family, from the last snapshot. */
export function quotaScore(accountId: string, family: Family): number | undefined {
  const q = getQuota(accountId) as (AgyQuota & { updatedAt: number }) | null;
  const f = q?.families?.[family];
  if (!f) return undefined;
  if (f.resetAt && f.resetAt < Date.now()) return undefined;
  return f.usedPercent;
}
