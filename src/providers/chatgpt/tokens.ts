// Access-token lifecycle for pool accounts: proactive refresh only when expired,
// reactive refresh on a real 401, per-account dedupe and transient backoff.
//
// OpenAI rotates refresh tokens and the legacy opencodex proxy may use the same accounts
// in parallel, so a token that is still valid is never refreshed except after a 401.

import { getAccount, setStatus, updateCredential } from "../../store/accounts.ts";
import { log } from "../../lib/log.ts";
import type { Account } from "../../types.ts";
import { credentialFromTokens, jwtExpiryMs, RefreshError, refreshTokens, tokenIdentity, type ChatgptCredential } from "./oauth.ts";

/** Refresh when the token expires within this window. */
export const REFRESH_SKEW_MS = 60_000;
const BACKOFF_MS = [2_000, 5_000, 15_000, 30_000, 60_000];

/** The account cannot be used until the user signs in again. */
export class ReauthRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReauthRequiredError";
  }
}

/** The token could not be refreshed right now; try another account. */
export class TransientAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TransientAuthError";
  }
}

const inflight = new Map<string, Promise<ChatgptCredential>>();
const backoff = new Map<string, { failures: number; until: number }>();

export function credentialOf(acc: Account): ChatgptCredential {
  const c = acc.credential as Partial<ChatgptCredential>;
  const accessToken = typeof c.accessToken === "string" ? c.accessToken : "";
  let expiresAt = Number(c.expiresAt ?? 0);
  // Imported credentials may lack expiresAt: fall back to the JWT's own `exp`.
  if (!Number.isFinite(expiresAt) || expiresAt <= 0) expiresAt = jwtExpiryMs(accessToken);
  const cred: ChatgptCredential = {
    ...(c as Record<string, unknown>),
    accessToken,
    refreshToken: typeof c.refreshToken === "string" ? c.refreshToken : "",
    expiresAt,
  };
  if (!cred.chatgptAccountId) {
    const id = tokenIdentity(cred.idToken, accessToken).accountId;
    if (id) cred.chatgptAccountId = id;
  }
  return cred;
}

export function isExpiring(cred: ChatgptCredential, now = Date.now()): boolean {
  // expiresAt 0 = unknown and no JWT exp: treat as usable (a 401 will tell us otherwise).
  return !cred.accessToken || (cred.expiresAt > 0 && cred.expiresAt <= now + REFRESH_SKEW_MS);
}

function refreshDisabled(): boolean {
  return process.env.CH_CHATGPT_NO_REFRESH === "1";
}

/** Return a usable credential, refreshing only if the stored access token is (nearly) expired. */
export async function ensureFreshCredential(acc: Account): Promise<ChatgptCredential> {
  const cred = credentialOf(acc);
  if (!isExpiring(cred)) return cred;
  return refreshAccount(acc.id, cred.accessToken);
}

/**
 * Refresh after the upstream rejected `staleAccessToken` with 401/403.
 * Throws ReauthRequiredError if the refresh returns the same bearer.
 */
export async function refreshAfterUnauthorized(acc: Account, staleAccessToken: string): Promise<ChatgptCredential> {
  const cred = await refreshAccount(acc.id, staleAccessToken, true);
  if (cred.accessToken === staleAccessToken) {
    setStatus(acc.id, "needs_reauth", "refresh returned the rejected token");
    throw new ReauthRequiredError("ChatGPT refresh returned the same (rejected) token; sign in again");
  }
  return cred;
}

/**
 * Deduped refresh. If another caller already replaced `staleAccessToken` with a token
 * that is still valid, that token is reused instead of spending the refresh token again.
 */
export function refreshAccount(accountId: string, staleAccessToken: string, reactive = false): Promise<ChatgptCredential> {
  const running = inflight.get(accountId);
  if (running) return running;
  const p = doRefresh(accountId, staleAccessToken, reactive).finally(() => inflight.delete(accountId));
  inflight.set(accountId, p);
  return p;
}

async function doRefresh(accountId: string, staleAccessToken: string, reactive: boolean): Promise<ChatgptCredential> {
  const acc = getAccount(accountId);
  if (!acc) throw new ReauthRequiredError("account no longer exists");
  const cur = credentialOf(acc);
  if (cur.accessToken && cur.accessToken !== staleAccessToken && !isExpiring(cur)) return cur;
  if (!cur.refreshToken) {
    setStatus(accountId, "needs_reauth", "no refresh token");
    throw new ReauthRequiredError("ChatGPT account has no refresh token; sign in again");
  }
  if (refreshDisabled()) throw new TransientAuthError("token refresh disabled (CH_CHATGPT_NO_REFRESH=1)");
  const b = backoff.get(accountId);
  if (b && b.until > Date.now()) {
    throw new TransientAuthError(`token refresh backing off for ${Math.ceil((b.until - Date.now()) / 1000)}s`);
  }
  try {
    const next = credentialFromTokens(await refreshTokens(cur.refreshToken), cur);
    // Keep any extra fields the stored credential had.
    const merged: ChatgptCredential = { ...cur, ...next };
    updateCredential(accountId, merged);
    backoff.delete(accountId);
    log.info(`chatgpt token refreshed acct=${accountId}${reactive ? " (after 401)" : ""}`);
    return merged;
  } catch (err) {
    if (err instanceof RefreshError && err.kind !== "transient") {
      const detail = err.kind === "revoked" ? "refresh token revoked" : "refresh token expired";
      setStatus(accountId, "needs_reauth", detail);
      throw new ReauthRequiredError(`${err.message} (${detail}); sign in again`);
    }
    const failures = (b?.failures ?? 0) + 1;
    const wait = BACKOFF_MS[Math.min(failures, BACKOFF_MS.length) - 1]!;
    backoff.set(accountId, { failures, until: Date.now() + wait });
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`chatgpt token refresh failed acct=${accountId} (retry in ${wait / 1000}s)`, msg);
    throw new TransientAuthError(msg);
  }
}

/** Tests only. */
export function resetTokenState(): void {
  inflight.clear();
  backoff.clear();
}
