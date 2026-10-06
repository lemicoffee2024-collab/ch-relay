import {
  clearAffinityForAccount,
  getAffinity,
  isCooling,
  listAccounts,
  setAffinity,
  setCooldown,
} from "./store/accounts.ts";
import type { Account, ProviderId } from "./types.ts";

export interface PickOptions {
  sessionKey?: string;
  /** Cooldown scope (model family). '*' cooldowns always apply. */
  scope?: string;
  /** Accounts already tried in this request. */
  exclude?: Set<string>;
  /**
   * Usage score 0..100 (higher = more used), or undefined if unknown.
   * Accounts at/above `threshold` are only used when nothing else is available.
   */
  score?: (a: Account) => number | undefined;
  threshold?: number;
}

/**
 * Pick an account for a request:
 * 1. keep the conversation on its bound account while it is usable (prompt cache);
 * 2. otherwise highest priority tier, then lowest usage score (unknown = 0), then round-robin by least-recent use.
 */
export function pickAccount(provider: ProviderId, opts: PickOptions = {}): Account | null {
  const scope = opts.scope ?? "*";
  const threshold = opts.threshold ?? 100;
  const usable = listAccounts(provider).filter(
    (a) => a.enabled && a.status !== "needs_reauth" && !opts.exclude?.has(a.id) && !isCooling(a.id, scope),
  );
  if (usable.length === 0) return null;

  if (opts.sessionKey) {
    const bound = getAffinity(opts.sessionKey, provider);
    const acc = bound ? usable.find((a) => a.id === bound) : undefined;
    if (acc && (opts.score?.(acc) ?? 0) < 100) return acc;
  }

  const score = (a: Account) => opts.score?.(a) ?? 0;
  const withHeadroom = usable.filter((a) => score(a) < threshold);
  const candidates = withHeadroom.length ? withHeadroom : usable;
  const topPriority = Math.max(...candidates.map((a) => a.priority));
  const tier = candidates.filter((a) => a.priority === topPriority);
  tier.sort((a, b) => score(a) - score(b) || lastUsed(a.id) - lastUsed(b.id));
  const chosen = tier[0]!;
  if (opts.sessionKey) setAffinity(opts.sessionKey, provider, chosen.id);
  lastUse.set(chosen.id, Date.now());
  return chosen;
}

const lastUse = new Map<string, number>();
function lastUsed(id: string): number {
  return lastUse.get(id) ?? 0;
}

/** Record a hard failure (quota / rate limit): cool the account and drop its conversation bindings. */
export function coolDown(accountId: string, scope: string, ms: number, reason: string): void {
  setCooldown(accountId, scope, Date.now() + Math.max(1000, ms), reason);
  clearAffinityForAccount(accountId);
}

/** Parse Retry-After (seconds or HTTP date) into ms, or undefined. */
export function retryAfterMs(headers: Headers): number | undefined {
  const v = headers.get("retry-after");
  if (!v) return undefined;
  const secs = Number(v);
  if (Number.isFinite(secs)) return Math.min(secs * 1000, 24 * 3600_000);
  const date = Date.parse(v);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}
