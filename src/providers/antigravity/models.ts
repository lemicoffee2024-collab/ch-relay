// Antigravity picker models, effort ladders and picker → wire model mapping.
import type { CatalogModel } from "../../types.ts";
import { PROVIDER_PREFIX } from "../../types.ts";

export interface AgyModelDef {
  id: string;
  contextWindow: number;
  efforts: string[];
  defaultEffort: string;
  modalities: Array<"text" | "image">;
}

/** Fixed picker list (image-generation models excluded on purpose). */
export const AGY_MODELS: AgyModelDef[] = [
  { id: "gemini-3.8-flash", contextWindow: 1_048_576, efforts: ["low", "medium", "high"], defaultEffort: "medium", modalities: ["text", "image"] },
  { id: "gemini-3.7-flash", contextWindow: 1_048_576, efforts: ["low", "medium", "high"], defaultEffort: "medium", modalities: ["text", "image"] },
  { id: "gemini-3.1-pro", contextWindow: 1_048_576, efforts: ["low", "high"], defaultEffort: "high", modalities: ["text", "image"] },
  { id: "claude-sonnet-4-6", contextWindow: 250_000, efforts: ["low", "medium", "high", "max"], defaultEffort: "high", modalities: ["text", "image"] },
  { id: "claude-opus-4-6-thinking", contextWindow: 250_000, efforts: ["low", "medium", "high", "max"], defaultEffort: "high", modalities: ["text", "image"] },
  { id: "gpt-oss-120b-medium", contextWindow: 131_072, efforts: [], defaultEffort: "medium", modalities: ["text"] },
];

/** Wire ids reported by fetchAvailableModels → picker id. */
const WIRE_TO_PICKER: Record<string, string> = {
  "gemini-3.8-flash-low": "gemini-3.8-flash",
  "gemini-3.8-flash-medium": "gemini-3.8-flash",
  "gemini-3.8-flash-high": "gemini-3.8-flash",
  "gemini-3.7-flash-tiered": "gemini-3.7-flash",
  "gemini-3.1-pro-low": "gemini-3.1-pro",
  "gemini-pro-agent": "gemini-3.1-pro",
};

export function pickerIdForWire(wire: string): string {
  return WIRE_TO_PICKER[wire] ?? wire;
}

const THINKING_LEVELS = new Set(["low", "medium", "high"]);

function thinkingLevel(effort: string | undefined): string | undefined {
  if (!effort) return undefined;
  if (effort === "xhigh" || effort === "max" || effort === "ultra") return "high";
  if (effort === "minimal") return "low";
  return THINKING_LEVELS.has(effort) ? effort : undefined;
}

export interface WireModel {
  wire: string;
  thinkingLevel?: string;
}

/** Map picker model + Codex effort to the CCA wire model id and optional thinkingLevel. */
export function resolveWireModel(model: string, effort: string | undefined): WireModel {
  const level = thinkingLevel(effort);
  switch (model) {
    case "gemini-3.8-flash":
      return { wire: `gemini-3.8-flash-${level ?? "medium"}` };
    case "gemini-3.7-flash":
      return { wire: "gemini-3.7-flash-tiered", thinkingLevel: level ?? "medium" };
    case "gemini-3.1-pro": {
      const l = level === "low" ? "low" : level === "medium" || level === "high" ? "high" : "high";
      return l === "low" ? { wire: "gemini-3.1-pro-low", thinkingLevel: "low" } : { wire: "gemini-pro-agent", thinkingLevel: "high" };
    }
  }
  if (/^claude-/.test(model)) return level ? { wire: model, thinkingLevel: level } : { wire: model };
  return { wire: model };
}

/** Cooldown / quota family of a wire model. */
export function modelFamily(wire: string): "gem" | "cla" {
  return /^gemini/i.test(wire) ? "gem" : "cla";
}

export function maxOutputTokens(wire: string): number | undefined {
  const lower = wire.toLowerCase();
  if (lower.startsWith("gemini")) return /(^|[-.])pro([-.]|$)/.test(lower) ? 65535 : 65536;
  if (lower.startsWith("claude")) return 64000;
  if (lower.startsWith("gpt-oss")) return 32768;
  return undefined;
}

export function toCatalog(def: AgyModelDef, contextWindow = def.contextWindow): CatalogModel {
  return {
    slug: `${PROVIDER_PREFIX.antigravity}/${def.id}`,
    displayName: `agy/${def.id}`,
    provider: "antigravity",
    contextWindow,
    reasoningLevels: [...def.efforts],
    defaultReasoning: def.defaultEffort,
    inputModalities: [...def.modalities],
  };
}

/**
 * Parse a fetchAvailableModels payload into picker ids that the account can serve, plus
 * their context windows. Image-generation models are ignored.
 */
export function parseAvailableModels(payload: unknown): Map<string, { contextWindow?: number }> {
  const out = new Map<string, { contextWindow?: number }>();
  const models = (payload as { models?: Record<string, unknown> } | null)?.models;
  if (!models || typeof models !== "object") return out;
  const imageIds = new Set(
    Array.isArray((payload as { imageGenerationModelIds?: unknown }).imageGenerationModelIds)
      ? ((payload as { imageGenerationModelIds: unknown[] }).imageGenerationModelIds as string[])
      : [],
  );
  for (const [wire, raw] of Object.entries(models)) {
    if (imageIds.has(wire) || /image/i.test(wire)) continue;
    const info = (raw ?? {}) as { maxTokens?: unknown };
    const picker = pickerIdForWire(wire);
    const max = typeof info.maxTokens === "number" && info.maxTokens > 0 ? info.maxTokens : undefined;
    const prev = out.get(picker);
    out.set(picker, { contextWindow: prev?.contextWindow ?? max });
  }
  return out;
}
