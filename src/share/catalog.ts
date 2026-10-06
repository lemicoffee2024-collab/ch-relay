// Codex catalog handed to share users: upstream's visible models under their
// real names, so remote Codex shows the default model list it normally would.

import { ASTRA_SLUG, buildChatgptCatalog } from "../providers/chatgpt/catalog.ts";

export interface ShareCatalog {
  models: Array<Record<string, unknown>>;
  defaultModel: string;
}

export function buildShareCatalog(): ShareCatalog {
  const models: Array<Record<string, unknown>> = [];
  for (const entry of buildChatgptCatalog()) {
    // Hidden entries (Astra, legacy) stay hidden.
    if (entry.visibility === "hide") continue;
    models.push(structuredClone(entry));
  }
  // Astra is the flagship — default to it when published, else first listed.
  const defaultModel = models.some((m) => m.slug === ASTRA_SLUG) ? ASTRA_SLUG : models[0] ? String(models[0].slug) : "";
  return { models, defaultModel };
}
