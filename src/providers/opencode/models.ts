// Model metadata and per-model wire quirks for OpenCode Zen / Go.
// Sources: opencodex registry (entries-core.ts opencode-go, entries-extended.ts opencode-zen,
// model-seeds.ts) and the user's ~/.opencodex/config.json provider rows.

export type OpencodeProviderId = "opencode-zen" | "opencode-go";
export type Wire = "chat" | "responses" | "anthropic";

export const BASE_URL: Record<OpencodeProviderId, string> = {
  "opencode-zen": "https://opencode.ai/zen/v1",
  "opencode-go": "https://opencode.ai/zen/go/v1",
};

const inList = (list: readonly string[], id: string) => list.includes(id);

// ---------------------------------------------------------------------------
// Wire selection
// ---------------------------------------------------------------------------

/** Go models documented on the Responses endpoint (exact allowlist). */
const GO_RESPONSES_MODELS = [
  "gpt-5.6-luna",
  "gpt-6-luna",
  "grok-4.6",
  "grok-4.7",
  "muse-spark-1.2-contributor",
  "muse-spark-1.3-contributor",
];
/** Go models documented on the Anthropic Messages endpoint. */
const GO_ANTHROPIC_MODELS = ["minimax-m2.5", "minimax-m2.7", "minimax-m3", "union-alpha"];

export function wireFor(provider: OpencodeProviderId, model: string): Wire {
  if (provider === "opencode-go") {
    if (inList(GO_RESPONSES_MODELS, model)) return "responses";
    if (inList(GO_ANTHROPIC_MODELS, model)) return "anthropic";
    return "chat";
  }
  // Zen: OpenAI-family and Muse Spark models are served on /responses (opencodex's
  // `opencode-zen-muse` row uses the openai-responses adapter), Claude natively on /messages.
  if (/^(gpt-|muse-spark-)/.test(model)) return "responses";
  if (/^claude-/.test(model)) return "anthropic";
  return "chat";
}

// ---------------------------------------------------------------------------
// Reasoning quirks (applied by model id on both gateways; same upstream vendors)
// ---------------------------------------------------------------------------

/** thinking: {type: enabled|disabled}. */
export const THINKING_TOGGLE_MODELS = ["mimo-v2.5", "mimo-v2.5-pro", "glm-5", "glm-5.1", "mimo-v2.6-pro", "mimo-v2.6-flash"];
const THINKING_TOGGLE_MAP: Record<string, string> = {
  none: "disabled",
  minimal: "disabled",
  low: "disabled",
  medium: "enabled",
  high: "enabled",
  xhigh: "enabled",
  max: "enabled",
};
/** thinking_budget = floor(maxTokens * fraction). */
export const THINKING_BUDGET_MODELS = ["qwen3.5-plus", "qwen3.6-plus", "qwen3.7-max", "qwen3.7-plus"];
const BUDGET_FRACTION: Record<string, number> = { low: 0.2, medium: 0.5, high: 0.75, xhigh: 0.9, max: 1 };
/** Models that must not receive any reasoning field. */
export const NO_REASONING_MODELS = ["kimi-k2.7-code", "kimi-k2.7-code-highspeed"];
/** Models that reject temperature / top_p / penalties. */
export const LOCKED_SAMPLING_MODELS = ["kimi-k3", "kimi-k2.7-code", "kimi-k2.7-code-highspeed"];
/** Models that only accept tool_choice auto|none. */
export const AUTO_TOOL_CHOICE_ONLY_MODELS = ["kimi-k2.7-code", "kimi-k2.7-code-highspeed"];

const isDeepseek = (m: string) => /^deepseek-/.test(m);

/** Assistant reasoning_content must be replayed on tool-call continuations (DeepSeek 400s otherwise). */
export function preservesReasoning(model: string): boolean {
  return (
    isDeepseek(model) ||
    inList(["glm-5.3", "glm-5.3-flash", "glm-5.2", "kimi-k3", "kimi-k2.7-code", "kimi-k2.7-code-highspeed"], model)
  );
}

/** response_format json_schema is rejected upstream; downgrade to json_object. */
export function noJsonSchema(model: string): boolean {
  return isDeepseek(model);
}

const DEEPSEEK_MAP: Record<string, string> = { low: "low", medium: "high", high: "high", xhigh: "high", max: "max" };
const KIMI_K3_MAP: Record<string, string> = { none: "none", low: "low", medium: "high", high: "high", xhigh: "max", max: "max" };

const EFFORT_ORDER = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];

/** Clamp an effort to the closest level the model advertises (prefer the next lower one). */
export function clampEffort(effort: string, levels: string[]): string {
  if (!levels.length || levels.includes(effort)) return effort;
  const idx = EFFORT_ORDER.indexOf(effort);
  if (idx < 0) return levels.includes("medium") ? "medium" : levels[0]!;
  for (let i = idx - 1; i >= 0; i--) if (levels.includes(EFFORT_ORDER[i]!)) return EFFORT_ORDER[i]!;
  for (let i = idx + 1; i < EFFORT_ORDER.length; i++) if (levels.includes(EFFORT_ORDER[i]!)) return EFFORT_ORDER[i]!;
  return levels[0]!;
}

export type ChatReasoningFields =
  | { reasoning_effort: string }
  | { thinking: { type: "enabled" | "disabled" } }
  | { thinking_budget: number }
  | Record<string, never>;

/** Chat Completions reasoning fields for a requested Codex effort. */
export function chatReasoningFields(model: string, effort: string | undefined, maxTokens?: number): ChatReasoningFields {
  if (!effort || inList(NO_REASONING_MODELS, model)) return {};
  if (inList(THINKING_TOGGLE_MODELS, model)) {
    const t = THINKING_TOGGLE_MAP[effort];
    return t ? { thinking: { type: t as "enabled" | "disabled" } } : {};
  }
  if (inList(THINKING_BUDGET_MODELS, model)) {
    if (effort === "none" || effort === "minimal") return { thinking_budget: 0 };
    const f = BUDGET_FRACTION[effort];
    return f === undefined ? {} : { thinking_budget: Math.max(1, Math.floor((maxTokens ?? 32768) * f)) };
  }
  if (isDeepseek(model)) {
    const e = DEEPSEEK_MAP[effort];
    return e ? { reasoning_effort: e } : {};
  }
  if (model === "kimi-k3") {
    const e = KIMI_K3_MAP[effort];
    return e ? { reasoning_effort: e } : {};
  }
  const levels = metaFor(model).reasoningLevels;
  return { reasoning_effort: clampEffort(effort, levels) };
}

// ---------------------------------------------------------------------------
// Catalog metadata
// ---------------------------------------------------------------------------

export interface ModelMeta {
  contextWindow: number;
  image: boolean;
  reasoningLevels: string[];
  defaultReasoning: string;
}

const STD = ["low", "medium", "high"];
const FIVE = ["low", "medium", "high", "xhigh", "max"];

/** Zen models measured text-only (image_url rejected upstream). */
const TEXT_ONLY = [
  "big-pickle",
  "nemotron-3-ultra-free",
  "ling-3.0-flash-free",
  "north-mini-code-free",
  "laguna-s-2.1-free",
  "deepseek-v4-flash-free",
  "deepseek-v4-flash",
  "deepseek-v4-pro",
  "glm-5.3",
  "glm-5.2",
  "glm-5",
  "glm-5.1",
  "mimo-v2-pro",
  "mimo-v2.5-pro",
  "mimo-v2.6-pro",
  "mimo-v2.6-flash",
  "minimax-m2.5",
  "minimax-m2.7",
  "qwen3.7-max",
];

export function metaFor(model: string): ModelMeta {
  let contextWindow = 128_000;
  let image = false;
  let reasoningLevels: string[] = STD;
  let defaultReasoning = "medium";
  const m = model;

  if (/^gpt-/.test(m)) {
    contextWindow = 272_000;
    image = true;
    reasoningLevels = /nano|mini/.test(m) ? STD : ["low", "medium", "high", "xhigh"];
    if (m === "gpt-5.6-luna" || m === "gpt-6-luna") reasoningLevels = FIVE;
  } else if (/^claude-/.test(m)) {
    contextWindow = 200_000;
    image = true;
    reasoningLevels = /haiku/.test(m) ? STD : ["low", "medium", "high", "xhigh", "max"];
    defaultReasoning = "high";
  } else if (/^gemini-/.test(m)) {
    contextWindow = 1_048_576;
    image = true;
    reasoningLevels = /pro/.test(m) ? ["low", "high"] : STD;
    defaultReasoning = /pro/.test(m) ? "high" : "medium";
  } else if (/^grok-/.test(m)) {
    contextWindow = 256_000;
    image = /^grok-4\.[67]$/.test(m);
    reasoningLevels = ["low", "medium", "high", "xhigh"];
    defaultReasoning = "high";
  } else if (/^muse-spark-/.test(m)) {
    contextWindow = 1_048_576;
    image = true;
    reasoningLevels = STD;
  } else if (/^deepseek-/.test(m)) {
    contextWindow = 1_048_576;
    image = m === "deepseek-v4.1-flash" || m === "deepseek-v4-flash-vision-exp" || m === "deepseek-flash";
    reasoningLevels = ["low", "high", "max"];
    defaultReasoning = "high";
  } else if (/^kimi-k3/.test(m)) {
    contextWindow = 262_144;
    image = true;
    reasoningLevels = ["low", "high", "max"];
    defaultReasoning = "max";
  } else if (/^kimi-k2\.7-code/.test(m)) {
    contextWindow = 262_144;
    image = true;
    reasoningLevels = [];
  } else if (/^kimi-/.test(m)) {
    contextWindow = 262_144;
    image = /k2\.[67]/.test(m);
    reasoningLevels = [];
  } else if (/^glm-5\.3/.test(m)) {
    contextWindow = 200_000;
    image = m === "glm-5.3-flash";
    reasoningLevels = ["low", "high", "max"];
    defaultReasoning = "high";
  } else if (/^glm-5\.2/.test(m)) {
    contextWindow = 200_000;
    reasoningLevels = FIVE;
  } else if (/^glm-/.test(m)) {
    contextWindow = 200_000;
    reasoningLevels = FIVE;
  } else if (/^qwen3\.8/.test(m)) {
    contextWindow = 262_144;
    image = true;
    reasoningLevels = ["low", "medium", "xhigh"];
  } else if (/^qwen/.test(m)) {
    contextWindow = 262_144;
    image = true;
    reasoningLevels = FIVE;
  } else if (/^mimo-/.test(m)) {
    contextWindow = /v2\.6/.test(m) ? 1_048_576 : 262_144;
    image = true;
    reasoningLevels = FIVE;
  } else if (/^minimax-/.test(m)) {
    contextWindow = 204_800;
    image = m === "minimax-m3";
    reasoningLevels = [];
  } else if (/^longcat-/.test(m)) {
    contextWindow = 262_144;
    image = /free/.test(m) || m === "longcat-2.0";
    reasoningLevels = [];
  } else if (/^hy\d/.test(m)) {
    contextWindow = 192_000;
    reasoningLevels = [];
  } else {
    reasoningLevels = [];
  }

  if (inList(TEXT_ONLY, m)) image = false;
  if (inList(THINKING_TOGGLE_MODELS, m) || inList(THINKING_BUDGET_MODELS, m)) reasoningLevels = FIVE;
  if (inList(NO_REASONING_MODELS, m)) reasoningLevels = [];
  if (!reasoningLevels.includes(defaultReasoning)) {
    defaultReasoning = reasoningLevels.includes("medium") ? "medium" : (reasoningLevels[0] ?? "medium");
  }
  return { contextWindow, image, reasoningLevels, defaultReasoning };
}

/** Obviously non-chat or internal ids on the gateways. */
export function isChatModel(id: string): boolean {
  if (/^test\b|^test-/.test(id)) return false;
  if (/embed|whisper|tts|transcribe|dall-e|image-|moderation|rerank/i.test(id)) return false;
  return true;
}

/**
 * Zen's keyless/free tier only admits OpenCode's own client (FreeTierError / MissingSessionID).
 * ch-relay does not impersonate that client, so these are hidden in the catalog.
 */
export function isFreeTierOnly(provider: OpencodeProviderId, id: string): boolean {
  return provider === "opencode-zen" && (/-free$/.test(id) || id === "big-pickle");
}

/** Static fallback rosters (live /models snapshot 2026-09-24). */
export const STATIC_MODELS: Record<OpencodeProviderId, string[]> = {
  "opencode-zen": [
    "claude-haiku-4-5", "claude-sonnet-4-6", "claude-sonnet-5", "claude-opus-4-8", "claude-opus-5", "claude-opus-5-5",
    "claude-fable-5", "claude-fable-5-1",
    "deepseek-v4-flash", "deepseek-v4.1-flash", "deepseek-v4-pro",
    "gemini-3.1-pro", "gemini-3.7-flash", "gemini-3.8-flash",
    "glm-5.1", "glm-5.2", "glm-5.3", "glm-5.3-flash",
    "gpt-5.5", "gpt-5.6-luna", "gpt-5.6-sol", "gpt-6-luna", "gpt-6-sol",
    "grok-4.6", "grok-4.7",
    "kimi-k2.6", "kimi-k2.7-code", "kimi-k3",
    "minimax-m2.7", "minimax-m3",
    "muse-spark-1.3",
    "qwen3.6-plus", "qwen3.8-flash",
  ],
  "opencode-go": [
    "deepseek-v4-flash", "deepseek-v4.1-flash", "deepseek-v4-pro",
    "glm-5.1", "glm-5.2", "glm-5.3", "glm-5.3-flash",
    "grok-4.6", "grok-4.7",
    "muse-spark-1.2-contributor", "muse-spark-1.3-contributor",
    "gpt-5.6-luna", "gpt-6-luna",
    "kimi-k2.6", "kimi-k2.7-code", "kimi-k3",
    "mimo-v2.5", "mimo-v2.5-pro", "mimo-v2.6-flash", "mimo-v2.6-pro",
    "minimax-m2.5", "minimax-m2.7", "minimax-m3",
    "qwen3.6-plus", "qwen3.7-max", "qwen3.7-plus", "qwen3.8-max", "qwen3.8-flash",
  ],
};
