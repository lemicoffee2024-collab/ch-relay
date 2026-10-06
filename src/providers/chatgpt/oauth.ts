// ChatGPT (OpenAI) OAuth primitives: constants, PKCE, JWT identity, token exchange and refresh.

export const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
import { pinnedFetch } from "../../net/pin.ts";

export const AUTH_URL = "https://auth.openai.com/oauth/authorize";
export const TOKEN_URL = "https://auth.openai.com/oauth/token";
export const SCOPE = "openid profile email offline_access api.connectors.read api.connectors.invoke";
export const CALLBACK_PORT = 1455;
export const CALLBACK_PATH = "/auth/callback";
export const REDIRECT_URI = `http://localhost:${CALLBACK_PORT}${CALLBACK_PATH}`;
export const ORIGINATOR = "codex_cli_rs";

export const DEVICE_USERCODE_URL = "https://auth.openai.com/api/accounts/deviceauth/usercode";
export const DEVICE_TOKEN_URL = "https://auth.openai.com/api/accounts/deviceauth/token";
export const DEVICE_REDIRECT_URI = "https://auth.openai.com/deviceauth/callback";
export const DEVICE_VERIFICATION_URL = "https://auth.openai.com/codex/device";

const AUTH_NS = "https://api.openai.com/auth";

/** Stored credential shape for ChatGPT accounts (see import-opencodex.ts). */
export interface ChatgptCredential {
  accessToken: string;
  refreshToken: string;
  idToken?: string;
  /** Epoch ms. */
  expiresAt: number;
  chatgptAccountId?: string;
  [key: string]: unknown;
}

export function decodeJwt(token: string | undefined): Record<string, any> {
  if (!token) return {};
  const part = token.split(".")[1];
  if (!part) return {};
  try {
    const v = JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

export interface TokenIdentity {
  accountId?: string;
  email?: string;
  plan?: string;
}

/** Read account id / email / plan from the id_token first, then the access token. */
export function tokenIdentity(idToken?: string, accessToken?: string): TokenIdentity {
  const out: TokenIdentity = {};
  for (const t of [idToken, accessToken]) {
    const p = decodeJwt(t);
    const ns = p[AUTH_NS] && typeof p[AUTH_NS] === "object" ? p[AUTH_NS] : {};
    if (!out.accountId) {
      const id =
        (typeof p.chatgpt_account_id === "string" && p.chatgpt_account_id) ||
        (typeof ns.chatgpt_account_id === "string" && ns.chatgpt_account_id) ||
        (Array.isArray(p.organizations) && typeof p.organizations[0]?.id === "string" && p.organizations[0].id) ||
        undefined;
      if (id) out.accountId = id;
    }
    if (!out.email) {
      const email = p.email ?? p["https://api.openai.com/profile"]?.email;
      if (typeof email === "string" && email) out.email = email.toLowerCase();
    }
    if (!out.plan && typeof ns.chatgpt_plan_type === "string") out.plan = ns.chatgpt_plan_type;
  }
  return out;
}

/** JWT `exp` of a token in epoch ms, or 0 when unknown. */
export function jwtExpiryMs(token: string | undefined): number {
  const exp = Number(decodeJwt(token).exp);
  return Number.isFinite(exp) && exp > 0 ? exp * 1000 : 0;
}

// ---------------------------------------------------------------------------
// PKCE
// ---------------------------------------------------------------------------

export async function generatePkce(): Promise<{ verifier: string; challenge: string }> {
  const bytes = new Uint8Array(96);
  crypto.getRandomValues(bytes);
  const verifier = Buffer.from(bytes).toString("base64url");
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: Buffer.from(hash).toString("base64url") };
}

export function randomState(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString("hex");
}

/** Authorization URL; parameter order matches the Codex CLI. */
export function buildAuthUrl(challenge: string, state: string, opts: { forceLogin?: boolean } = {}): string {
  const params = new URLSearchParams();
  params.set("response_type", "code");
  params.set("client_id", CLIENT_ID);
  params.set("redirect_uri", REDIRECT_URI);
  params.set("scope", SCOPE);
  params.set("code_challenge", challenge);
  params.set("code_challenge_method", "S256");
  params.set("state", state);
  params.set("codex_cli_simplified_flow", "true");
  params.set("originator", ORIGINATOR);
  params.set("id_token_add_organizations", "true");
  if (opts.forceLogin) params.set("prompt", "login");
  return `${AUTH_URL}?${params}`;
}

// ---------------------------------------------------------------------------
// Token endpoint
// ---------------------------------------------------------------------------

export interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  id_token?: string;
  expires_in?: number;
  [key: string]: unknown;
}

/** Build a stored credential from a token endpoint response (keeps old values the response omits). */
export function credentialFromTokens(data: TokenResponse, prev?: Partial<ChatgptCredential>): ChatgptCredential {
  const accessToken = typeof data.access_token === "string" ? data.access_token : "";
  if (!accessToken) throw new Error("ChatGPT token response missing access_token");
  const idToken = typeof data.id_token === "string" && data.id_token ? data.id_token : prev?.idToken;
  const expiresIn = typeof data.expires_in === "number" && Number.isFinite(data.expires_in) && data.expires_in >= 0 ? data.expires_in : 3600;
  const ident = tokenIdentity(idToken, accessToken);
  const cred: ChatgptCredential = {
    accessToken,
    refreshToken: typeof data.refresh_token === "string" && data.refresh_token ? data.refresh_token : String(prev?.refreshToken ?? ""),
    expiresAt: Date.now() + expiresIn * 1000,
    chatgptAccountId: ident.accountId ?? prev?.chatgptAccountId,
  };
  if (idToken) cred.idToken = idToken;
  return cred;
}

async function errorSummary(res: Response): Promise<{ code: string; text: string }> {
  const text = await res.text().catch(() => "");
  let code = "";
  try {
    const j = JSON.parse(text);
    const e = j?.error;
    if (typeof e === "string") code = e;
    else if (e && typeof e === "object") code = String(e.code ?? e.type ?? "");
    if (!code && typeof j?.code === "string") code = j.code;
    const desc = typeof j?.error_description === "string" ? j.error_description : typeof e?.message === "string" ? e.message : "";
    return { code, text: [code, desc].filter(Boolean).join(": ") || `HTTP ${res.status}` };
  } catch {
    return { code, text: `HTTP ${res.status}` };
  }
}

export async function exchangeCode(code: string, verifier: string, redirectUri: string, signal?: AbortSignal): Promise<TokenResponse> {
  const res = await pinnedFetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      code,
      redirect_uri: redirectUri,
      code_verifier: verifier,
    }).toString(),
    signal: signal ?? AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const e = await errorSummary(res);
    throw new Error(`ChatGPT token exchange failed: ${res.status} ${e.text}`);
  }
  return (await res.json()) as TokenResponse;
}

export type RefreshErrorKind = "revoked" | "expired" | "transient";

export class RefreshError extends Error {
  constructor(
    readonly kind: RefreshErrorKind,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "RefreshError";
  }
}

/** Classify a refresh failure code per spec. */
export function classifyRefreshCode(code: string): RefreshErrorKind {
  const c = code.toLowerCase();
  if (c === "invalid_grant" || c === "refresh_token_invalidated" || c === "refresh_token_reused") return "revoked";
  if (c === "refresh_token_expired") return "expired";
  return "transient";
}

export async function refreshTokens(refreshToken: string): Promise<TokenResponse> {
  let res: Response;
  try {
    res = await pinnedFetch(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", client_id: CLIENT_ID, refresh_token: refreshToken }).toString(),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    throw new RefreshError("transient", `ChatGPT refresh network error: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!res.ok) {
    const e = await errorSummary(res);
    throw new RefreshError(classifyRefreshCode(e.code), `ChatGPT refresh failed: ${res.status} ${e.text}`, res.status);
  }
  return (await res.json()) as TokenResponse;
}
