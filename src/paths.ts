import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync, readFileSync } from "node:fs";

export const HOME = process.env.CH_HOME ?? join(homedir(), ".ch-relay");
export const DB_PATH = join(HOME, "ch-relay.sqlite");
export const LOG_PATH = join(HOME, "service.log");
export const PID_PATH = join(HOME, "ch-relay.pid");

export const CODEX_HOME = process.env.CODEX_HOME ?? join(homedir(), ".codex");
export const CODEX_CONFIG_PATH = join(CODEX_HOME, "config.toml");
export const CODEX_CATALOG_PATH = join(CODEX_HOME, "ch-relay-catalog.json");
export const CODEX_AGENTS_PATH = join(CODEX_HOME, "AGENTS.md");

export const OPENCODEX_HOME = join(homedir(), ".opencodex");

export const DEFAULT_PORT = Number(process.env.CH_PORT ?? 0);
/** Public share endpoint (127.0.0.1 only). 0 disables it. */
export const DEFAULT_SHARE_PORT = Number(process.env.CH_SHARE_PORT ?? 11500);
/** Remote admin console (127.0.0.1 only). Login required. 0 disables it. */
export const DEFAULT_ADMIN_PORT = Number(process.env.CH_ADMIN_PORT ?? 0);

/** `?k=<key>` for install URLs when the edge proxy gates them by key; "" otherwise. Read per call so key rotation shows up live. */
export function installKeyQuery(): string {
  const f = process.env.CH_INSTALL_KEY_FILE;
  if (!f) return "";
  try {
    const k = readFileSync(f, "utf8").trim();
    return k ? `?k=${encodeURIComponent(k)}` : "";
  } catch {
    return "";
  }
}

export function ensureHome(): void {
  mkdirSync(HOME, { recursive: true });
}
