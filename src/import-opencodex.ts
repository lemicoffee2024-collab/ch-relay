import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CODEX_HOME, OPENCODEX_HOME } from "./paths.ts";
import { listAccounts, upsertAccount } from "./store/accounts.ts";
import type { ProviderId } from "./types.ts";

/**
 * Credential shapes stored by ch-relay (accounts.credential):
 *  chatgpt:     { accessToken, refreshToken, idToken?, expiresAt(ms), chatgptAccountId }   meta: { plan? }
 *  antigravity: { accessToken, refreshToken, expiresAt(ms) }                               meta: { projectId }
 *  opencode-*:  { apiKey }
 */

function readJson(path: string): any {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

export function jwtPayload(token: string | undefined): Record<string, any> {
  if (!token) return {};
  const part = token.split(".")[1];
  if (!part) return {};
  try {
    return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
  } catch {
    return {};
  }
}

function jwtEmail(...tokens: Array<string | undefined>): string | null {
  for (const t of tokens) {
    const p = jwtPayload(t);
    const email = p.email ?? p["https://api.openai.com/profile"]?.email;
    if (typeof email === "string") return email.toLowerCase();
  }
  return null;
}

function jwtPlan(...tokens: Array<string | undefined>): string | undefined {
  for (const t of tokens) {
    const plan = jwtPayload(t)["https://api.openai.com/auth"]?.chatgpt_plan_type;
    if (typeof plan === "string") return plan;
  }
  return undefined;
}

export interface ImportResult {
  chatgpt: number;
  antigravity: number;
  opencodeZen: number;
  opencodeGo: number;
}

export async function importFromOpencodex(): Promise<ImportResult> {
  const res: ImportResult = { chatgpt: 0, antigravity: 0, opencodeZen: 0, opencodeGo: 0 };
  const config = readJson(join(OPENCODEX_HOME, "config.json")) ?? {};

  // --- ChatGPT pool accounts ---
  const meta = new Map<string, { email?: string; plan?: string }>();
  for (const m of config.codexAccounts ?? []) meta.set(m.id, m);
  const pool = readJson(join(OPENCODEX_HOME, "codex-accounts.json")) ?? {};
  for (const [id, rec] of Object.entries<any>(pool)) {
    const c = rec?.credential;
    if (!c || rec.deletedAt || !c.refreshToken) continue;
    const email = (meta.get(id)?.email ?? jwtEmail(c.accessToken))?.toLowerCase() ?? null;
    upsertAccount(
      {
        provider: "chatgpt",
        label: email ?? id,
        email,
        credential: {
          accessToken: c.accessToken,
          refreshToken: c.refreshToken,
          expiresAt: c.expiresAt ?? 0,
          chatgptAccountId: c.chatgptAccountId,
        },
        meta: { plan: meta.get(id)?.plan ?? jwtPlan(c.accessToken), importedFrom: "opencodex" },
      },
      { email },
    );
    res.chatgpt++;
  }

  // --- Codex CLI main login (~/.codex/auth.json) ---
  const main = readJson(join(CODEX_HOME, "auth.json"));
  const t = main?.tokens;
  if (t?.refresh_token && t?.access_token) {
    const email = jwtEmail(t.id_token, t.access_token);
    const exp = Number(jwtPayload(t.access_token).exp ?? 0) * 1000;
    upsertAccount(
      {
        provider: "chatgpt",
        label: email ?? "codex main",
        email,
        credential: {
          accessToken: t.access_token,
          refreshToken: t.refresh_token,
          idToken: t.id_token,
          expiresAt: exp,
          chatgptAccountId: t.account_id,
        },
        meta: { plan: jwtPlan(t.id_token, t.access_token), importedFrom: "codex-auth" },
      },
      { email },
    );
    res.chatgpt++;
  }

  // --- Antigravity ---
  const auth = readJson(join(OPENCODEX_HOME, "auth.json")) ?? {};
  for (const acc of auth["google-antigravity"]?.accounts ?? []) {
    const c = acc?.credential;
    if (!c?.refresh) continue;
    const email = (c.email as string | undefined)?.toLowerCase() ?? null;
    upsertAccount(
      {
        provider: "antigravity",
        label: email ?? acc.id,
        email,
        credential: { accessToken: c.access, refreshToken: c.refresh, expiresAt: c.expires ?? 0 },
        meta: { projectId: c.projectId, importedFrom: "opencodex" },
      },
      { email },
    );
    res.antigravity++;
  }

  // --- OpenCode keys ---
  const addKeys = (provider: ProviderId, cfg: any): number => {
    if (!cfg) return 0;
    const keys: Array<{ key: string; label?: string }> = [];
    if (typeof cfg.apiKey === "string") keys.push({ key: cfg.apiKey });
    for (const k of cfg.apiKeyPool ?? []) if (typeof k?.key === "string") keys.push({ key: k.key, label: k.label });
    const existing = new Set(listAccounts(provider).map((a) => a.credential.apiKey));
    let n = 0;
    for (const k of keys) {
      if (existing.has(k.key)) continue;
      existing.add(k.key);
      upsertAccount({
        provider,
        label: k.label ?? `${provider} …${k.key.slice(-4)}`,
        credential: { apiKey: k.key },
        meta: { importedFrom: "opencodex" },
      });
      n++;
    }
    return n;
  };
  const p = config.providers ?? {};
  res.opencodeZen = addKeys("opencode-zen", p["opencode-zen"]) + addKeys("opencode-zen", p["opencode-zen-muse"]);
  res.opencodeGo = addKeys("opencode-go", p["opencode-go"]);
  return res;
}
