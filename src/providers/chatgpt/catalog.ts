import baseline from "../../../data/chatgpt-models.baseline.json" with { type: "json" };
import type { CatalogModel } from "../../types.ts";

type RawEntry = Record<string, unknown> & { slug: string };

export const ASTRA_SLUG = "gpt-6-astra";
export const AUTO_REVIEW_SLUG = "openai/codex-auto-review";
export const AUTO_REVIEW_DISPLAY = "GPT-6 Astra";

/** Fields that are opencodex-private or only drive one-off UI popups. */
// service_tiers/additional_speed_tiers advertise a Fast tier the ChatGPT pool
// can't honor (upstream completes on "default"), which makes Codex churn
// cancelled retries — hide them so Codex never offers /fast.
const DROP_FIELDS = [
  "opencodex_capability_provenance",
  "opencodex_catalog_kind",
  "availability_nux",
  "upgrade",
  "service_tiers",
  "additional_speed_tiers",
  "default_service_tier",
  // ch-relay answers websocket probes with 426; don't make Codex prefer them.
  "prefer_websockets",
];

/** Product rule: always hidden regardless of upstream visibility. */
const FORCE_HIDDEN = new Set(["gpt-5.5"]);

/**
 * The upstream Astra snapshot currently advertises a larger max_context_window
 * than the context window ch-relay actually routes.  Codex uses these fields
 * to decide when to compact, so publish one internally consistent triple for
 * every ChatGPT entry (including the hidden Astra source).
 */
function normalizeContextFields(entry: RawEntry): void {
  const contextWindow = Number(entry.context_window);
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) return;
  entry.context_window = contextWindow;
  entry.max_context_window = contextWindow;
  entry.auto_compact_token_limit = Math.floor(contextWindow * 0.9);
}

/**
 * Build the ChatGPT part of the Codex catalog.
 * Product rule: publish upstream's default model list under its own names.
 * Hidden entries (Astra, legacy) stay hidden; codex-auto-review is retired
 * and never published.
 */
export function buildChatgptCatalog(source: RawEntry[] = (baseline as { models: RawEntry[] }).models): RawEntry[] {
  const out: RawEntry[] = [];
  for (const entry of source) {
    if (entry.slug === AUTO_REVIEW_SLUG || entry.slug === "codex-auto-review") continue;
    const copy = structuredClone(entry);
    for (const f of DROP_FIELDS) delete copy[f];
    normalizeContextFields(copy);
    if (FORCE_HIDDEN.has(copy.slug)) copy.visibility = "hide";
    out.push(copy);
  }
  return out;
}

export function chatgptCatalogModels(): CatalogModel[] {
  return buildChatgptCatalog().map((raw) => ({
    slug: raw.slug,
    displayName: String(raw.display_name ?? raw.slug),
    provider: "chatgpt" as const,
    contextWindow: Number(raw.context_window ?? 272000),
    reasoningLevels: ((raw.supported_reasoning_levels as Array<{ effort: string }>) ?? []).map((l) => l.effort),
    defaultReasoning: String(raw.default_reasoning_level ?? "medium"),
    inputModalities: (raw.input_modalities as Array<"text" | "image">) ?? ["text"],
    hidden: raw.visibility === "hide",
    raw,
  }));
}

export function wireEffort(_wire: string, effort: string | undefined): string | undefined {
  // The codex/responses endpoint rejects "ultra" outright for every model
  // (valid ladder ends at "max"); clamp globally.
  return effort === "ultra" ? "max" : effort;
}

/** Upstream model id for a ChatGPT catalog slug (`openai/x` -> `x`).
 *  codex-auto-review is retired from the pool: Codex still fires internal
 *  review calls on this slug — serve them as Astra so nothing errors. */
export function chatgptWireModel(slug: string): string {
  const wire = slug.startsWith("openai/") ? slug.slice("openai/".length) : slug;
  return wire === "codex-auto-review" ? ASTRA_SLUG : wire;
}
