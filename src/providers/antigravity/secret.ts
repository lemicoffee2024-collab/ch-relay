// Resolve the Antigravity OAuth client secret without ever committing it to the repo.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getSetting, setSetting } from "../../store/db.ts";

const SETTING_KEY = "antigravity.clientSecret";
const SECRET_RE = /GOCSPX-[A-Za-z0-9_-]{20,}/;
const REL = join("@bitkyc08", "opencodex", "src", "oauth", "google-antigravity.ts");

let cached: string | null = null;

/** Candidate locations of the installed opencodex source file that embeds the secret. */
function candidateFiles(): string[] {
  const roots: string[] = [];
  if (process.env.OPENCODEX_PKG) roots.push(join(process.env.OPENCODEX_PKG, "..", ".."));
  if (process.env.APPDATA) roots.push(join(process.env.APPDATA, "npm", "node_modules"));
  roots.push(join(homedir(), ".bun", "install", "global", "node_modules"));
  roots.push("/usr/local/lib/node_modules", "/usr/lib/node_modules", "/opt/homebrew/lib/node_modules");
  const files = roots.map((r) => join(r, REL));
  if (process.env.OPENCODEX_PKG) files.unshift(join(process.env.OPENCODEX_PKG, "src", "oauth", "google-antigravity.ts"));
  return files;
}

function npmGlobalRoot(): string | null {
  try {
    const npm = process.platform === "win32" ? "npm.cmd" : "npm";
    const r = Bun.spawnSync([npm, "root", "-g"], { stdout: "pipe", stderr: "ignore" });
    const out = r.stdout.toString().trim();
    return out || null;
  } catch {
    return null;
  }
}

function extractFrom(file: string): string | null {
  try {
    if (!existsSync(file)) return null;
    return readFileSync(file, "utf8").match(SECRET_RE)?.[0] ?? null;
  } catch {
    return null;
  }
}

/**
 * Order: env GOOGLE_ANTIGRAVITY_CLIENT_SECRET → settings → extracted from installed opencodex
 * (persisted to settings). Returns null when unavailable.
 */
export function resolveClientSecret(): string | null {
  const env = process.env.GOOGLE_ANTIGRAVITY_CLIENT_SECRET?.trim();
  if (env) return env;
  if (cached) return cached;
  const stored = getSetting<string | null>(SETTING_KEY, null);
  if (stored) return (cached = stored);
  let found: string | null = null;
  for (const f of candidateFiles()) if ((found = extractFrom(f))) break;
  if (!found) {
    const root = npmGlobalRoot();
    if (root) found = extractFrom(join(root, REL));
  }
  if (found) {
    setSetting(SETTING_KEY, found);
    cached = found;
  }
  return found;
}

export function requireClientSecret(): string {
  const s = resolveClientSecret();
  if (!s) {
    throw new Error(
      "Antigravity OAuth client secret not found: set GOOGLE_ANTIGRAVITY_CLIENT_SECRET or install @bitkyc08/opencodex globally",
    );
  }
  return s;
}

/** For tests. */
export function resetClientSecretCache(): void {
  cached = null;
}
