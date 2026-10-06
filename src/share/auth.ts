// Verifies the ChatGPT access token Codex sends, against OpenAI's published signing keys.

import { pinnedFetch } from "../net/pin.ts";

const JWKS_URL = "https://auth.openai.com/.well-known/jwks.json";
const ISSUER = "https://auth.openai.com";
const AUDIENCE = "https://api.openai.com/v1";
const JWKS_TTL_MS = 6 * 3600_000;
/** Unknown kid: refetch at most this often (key rotation), so bad tokens can't hammer OpenAI. */
const JWKS_MIN_REFETCH_MS = 60_000;
const CLOCK_SKEW_S = 60;

export interface TokenIdentity {
  email: string;
  chatgptAccountId: string | undefined;
  userId: string | undefined;
  exp: number;
}

export type VerifyResult =
  | { ok: true; identity: TokenIdentity; expired: boolean }
  | { ok: false; reason: "missing" | "malformed" | "bad_signature" | "bad_claims" | "expired" | "jwks_unavailable" };

interface Jwk extends JsonWebKey {
  kid?: string;
}

let jwks: { keys: Jwk[]; fetchedAt: number } | null = null;
let lastFetchAt = 0;
const keyCache = new Map<string, CryptoKey>();

/** For tests: pin the key set instead of fetching it. */
export function setJwksForTests(keys: Jwk[] | null): void {
  jwks = keys ? { keys, fetchedAt: Date.now() } : null;
  lastFetchAt = 0;
  keyCache.clear();
}

async function fetchJwks(): Promise<void> {
  lastFetchAt = Date.now();
  const res = await pinnedFetch(JWKS_URL, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`jwks HTTP ${res.status}`);
  const body = (await res.json()) as { keys?: Jwk[] };
  if (!Array.isArray(body.keys) || body.keys.length === 0) throw new Error("jwks empty");
  jwks = { keys: body.keys, fetchedAt: Date.now() };
  keyCache.clear();
}

async function keyFor(kid: string): Promise<CryptoKey | null> {
  const cached = keyCache.get(kid);
  if (cached) return cached;
  const stale = !jwks || Date.now() - jwks.fetchedAt > JWKS_TTL_MS;
  let jwk = jwks?.keys.find((k) => k.kid === kid);
  if ((stale || !jwk) && Date.now() - lastFetchAt > JWKS_MIN_REFETCH_MS) {
    await fetchJwks();
    jwk = jwks?.keys.find((k) => k.kid === kid);
  }
  if (!jwk) return null;
  const { kid: _kid, ...material } = jwk;
  const key = await crypto.subtle.importKey("jwk", material, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  keyCache.set(kid, key);
  return key;
}

function b64json(part: string): Record<string, any> | null {
  try {
    const v = JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
    return v && typeof v === "object" ? v : null;
  } catch {
    return null;
  }
}

export function bearerToken(headers: Headers): string | null {
  const m = /^Bearer\s+(\S+)$/i.exec(headers.get("authorization") ?? "");
  return m ? m[1]! : null;
}

/**
 * Check signature, issuer, audience and expiry. `allowExpired` lets a still-signed but
 * expired token through (flagged `expired`), used only for catalog downloads.
 */
export async function verifyChatgptToken(token: string | null, opts: { allowExpired?: boolean } = {}): Promise<VerifyResult> {
  if (!token) return { ok: false, reason: "missing" };
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed" };
  const [h, p, s] = parts as [string, string, string];
  const header = b64json(h);
  const claims = b64json(p);
  if (!header || !claims || header.alg !== "RS256" || typeof header.kid !== "string") return { ok: false, reason: "malformed" };

  let key: CryptoKey | null;
  try {
    key = await keyFor(header.kid);
  } catch {
    return { ok: false, reason: "jwks_unavailable" };
  }
  if (!key) return { ok: false, reason: "bad_signature" };
  const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, Buffer.from(s, "base64url"), new TextEncoder().encode(`${h}.${p}`));
  if (!valid) return { ok: false, reason: "bad_signature" };

  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (claims.iss !== ISSUER || !aud.includes(AUDIENCE)) return { ok: false, reason: "bad_claims" };
  const now = Date.now() / 1000;
  if (typeof claims.nbf === "number" && claims.nbf > now + CLOCK_SKEW_S) return { ok: false, reason: "bad_claims" };
  const exp = Number(claims.exp);
  if (!Number.isFinite(exp)) return { ok: false, reason: "bad_claims" };
  const expired = exp < now - CLOCK_SKEW_S;
  if (expired && !opts.allowExpired) return { ok: false, reason: "expired" };

  const profile = claims["https://api.openai.com/profile"] ?? {};
  const auth = claims["https://api.openai.com/auth"] ?? {};
  const email = typeof profile.email === "string" ? profile.email.trim().toLowerCase() : "";
  if (!email || profile.email_verified === false) return { ok: false, reason: "bad_claims" };
  return {
    ok: true,
    expired,
    identity: {
      email,
      chatgptAccountId: typeof auth.chatgpt_account_id === "string" ? auth.chatgpt_account_id : undefined,
      userId: typeof auth.user_id === "string" ? auth.user_id : undefined,
      exp,
    },
  };
}
