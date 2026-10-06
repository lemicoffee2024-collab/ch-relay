import { resolveAlias } from "./store/modelmap.ts";
import type { ProviderId } from "./types.ts";

export interface Route {
  provider: ProviderId;
  /** Provider-local model id. */
  model: string;
}

const PREFIXES: Array<[string, ProviderId]> = [
  ["google-antigravity/", "antigravity"],
  ["agy/", "antigravity"],
  ["opencode-go/", "opencode-go"],
  ["opencode-zen/", "opencode-zen"],
  ["openai/", "chatgpt"],
];

/** Map a Codex model slug to a provider. Aliases resolve first; bare slugs are native ChatGPT models. */
export function route(slug: string): Route {
  const alias = resolveAlias(slug);
  if (alias) return { provider: alias.provider, model: alias.wire };
  for (const [prefix, provider] of PREFIXES) {
    if (slug.startsWith(prefix)) return { provider, model: slug.slice(prefix.length) };
  }
  return { provider: "chatgpt", model: slug };
}

/**
 * Stable conversation key from Codex headers. Codex sends `session_id`/`session-id`
 * and `thread-id`; sub-agents share the parent's session.
 */
export function sessionKeyFrom(headers: Headers, body: { prompt_cache_key?: string }): string | undefined {
  return (
    headers.get("session-id") ??
    headers.get("session_id") ??
    headers.get("x-codex-parent-thread-id") ??
    headers.get("thread-id") ??
    body.prompt_cache_key ??
    undefined
  ) || undefined;
}
