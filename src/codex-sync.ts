import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import template from "../data/routed-template.json" with { type: "json" };
import { CODEX_AGENTS_PATH, CODEX_CATALOG_PATH, CODEX_CONFIG_PATH } from "./paths.ts";
import { providers } from "./providers/index.ts";
import { AUTO_REVIEW_SLUG } from "./providers/chatgpt/catalog.ts";
import { route } from "./router.ts";
import { listAccounts } from "./store/accounts.ts";
import { existingAlias } from "./store/modelmap.ts";
import type { CatalogModel, ProviderId } from "./types.ts";

export const MARKER = "# Managed by ch-relay (undo: ch-relay unsync)";
const EFFORT_TEXT: Record<string, string> = {
  none: "No reasoning",
  minimal: "Minimal reasoning",
  low: "Fast responses with lighter reasoning",
  medium: "Balanced speed and reasoning depth",
  high: "Greater reasoning depth for complex problems",
  xhigh: "Extra high reasoning depth",
  max: "Maximum reasoning depth for the hardest problems",
};

/** Full Codex catalog entry for a routed (non-ChatGPT) model, satisfying Codex's strict parser. */
export function routedEntry(m: CatalogModel): Record<string, unknown> {
  const e: Record<string, unknown> = structuredClone(template);
  delete e.opencodex_capability_provenance;
  const levels = m.reasoningLevels.length ? m.reasoningLevels : ["medium"];
  Object.assign(e, {
    slug: m.slug,
    display_name: m.displayName,
    description: `Routed via ch-relay → ${m.provider}.`,
    visibility: m.hidden ? "hide" : "list",
    priority: 10,
    supported_reasoning_levels: levels.map((effort) => ({ effort, description: EFFORT_TEXT[effort] ?? effort })),
    default_reasoning_level: levels.includes(m.defaultReasoning) ? m.defaultReasoning : levels[0],
    context_window: m.contextWindow,
    max_context_window: m.contextWindow,
    auto_compact_token_limit: Math.floor(m.contextWindow * 0.9),
    input_modalities: m.inputModalities.length ? m.inputModalities : ["text"],
    comp_hash: "ch-relay",
  });
  return e;
}

/** Only providers that have at least one enabled account contribute models. */
export async function buildCatalog(): Promise<{ entries: Array<Record<string, unknown>>; slugMap: Map<string, string> }> {
  const out: Array<Record<string, unknown>> = [];
  const slugMap = new Map<string, string>();
  for (const id of Object.keys(providers) as ProviderId[]) {
    if (!listAccounts(id).some((a) => a.enabled)) continue;
    const models = await providers[id].models().catch(() => [] as CatalogModel[]);
    for (const m of models) {
      if (m.slug === AUTO_REVIEW_SLUG) continue;
      const e = m.raw ? structuredClone(m.raw) : routedEntry(m);
      // Publish the real slug. A legacy alias for this wire may still sit in
      // the customer's config.toml — map it so remapSelectedModel upgrades it.
      const r = route(String(e.slug));
      const legacy = existingAlias(r.provider, r.model);
      if (legacy) slugMap.set(legacy, String(e.slug));
      out.push(e);
    }
  }
  return { entries: out, slugMap };
}

// ---------------------------------------------------------------------------
// config.toml editing: only root keys directly under our marker line are ours.
// ---------------------------------------------------------------------------

const OWNED_KEYS = ["openai_base_url", "model_catalog_json"] as const;

function tomlString(s: string): string {
  return JSON.stringify(s.replace(/\\/g, "/"));
}

/** Remove our marker+key pairs. Keys without our marker (user's own) are kept. */
export function stripManaged(toml: string): string {
  const lines = toml.split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.trim() === MARKER) {
      i++; // skip marker and the owned line following it
      continue;
    }
    out.push(lines[i]!);
  }
  return out.join("\n");
}

/**
 * Point Codex at ch-relay. Existing unmarked `openai_base_url` / `model_catalog_json`
 * lines (e.g. opencodex's) are replaced: the user explicitly asked ch-relay to take over.
 */
export function applyManaged(toml: string, baseUrl: string, catalogPath: string): string {
  const lines = stripManaged(toml).split("\n");
  const firstTable = lines.findIndex((l) => /^\s*\[/.test(l));
  const rootEnd = firstTable === -1 ? lines.length : firstTable;
  const root: string[] = [];
  for (const line of lines.slice(0, rootEnd)) {
    const key = line.split("=")[0]?.trim() ?? "";
    const prev = root[root.length - 1] ?? "";
    const opencodexOwned = prev.includes("Auto-injected by opencodex");
    const replace = (OWNED_KEYS as readonly string[]).includes(key) || (opencodexOwned && key === "experimental_realtime_ws_base_url");
    if (replace) {
      if (opencodexOwned) root.pop(); // drop the other tool's marker above the key we take over
      continue;
    }
    root.push(line);
  }
  const managed = [MARKER, `openai_base_url = ${tomlString(baseUrl)}`, MARKER, `model_catalog_json = ${tomlString(catalogPath)}`];
  return [...managed, ...root, ...lines.slice(rootEnd)].join("\n");
}

// ---------------------------------------------------------------------------
// Global AGENTS.md (~/.codex/AGENTS.md): older builds wrote a managed block
// here; current sync leaves the file untouched but unsync still strips any
// leftover block so upgrades stay clean.
// ---------------------------------------------------------------------------

const AGENTS_BEGIN = "<!-- BEGIN Managed by ch-relay (undo: ch-relay unsync) -->";
const AGENTS_END = "<!-- END Managed by ch-relay -->";

/** Remove our BEGIN..END block (first occurrence); other content kept. */
export function stripManagedMd(md: string): string {
  const begin = md.indexOf(AGENTS_BEGIN);
  if (begin === -1) return md;
  const endAt = md.indexOf(AGENTS_END, begin);
  if (endAt === -1) return md; // malformed — leave user text alone
  const after = endAt + AGENTS_END.length;
  return (md.slice(0, begin) + md.slice(after)).replace(/\n{3,}/g, "\n\n");
}

export interface SyncResult {
  catalogPath: string;
  configPath: string;
  models: number;
  backup: string | null;
}

/** Rewrite root `model = "..."` when the configured slug was renamed (e.g. a legacy `ch/*` alias now published under its real name). */
function remapSelectedModel(toml: string, slugMap: Map<string, string>): string {
  const lines = toml.split("\n");
  const firstTable = lines.findIndex((l) => /^\s*\[/.test(l));
  const rootEnd = firstTable === -1 ? lines.length : firstTable;
  for (let i = 0; i < rootEnd; i++) {
    const m = /^(\s*model\s*=\s*")([^"]+)(".*)$/.exec(lines[i]!);
    if (!m) continue;
    const alias = slugMap.get(m[2]!);
    if (alias) lines[i] = `${m[1]}${alias}${m[3]}`;
    break;
  }
  return lines.join("\n");
}

export async function syncCodex(port: number): Promise<SyncResult> {
  const { entries: models, slugMap } = await buildCatalog();
  if (models.length === 0) throw new Error("no models: add at least one account first");
  writeFileSync(CODEX_CATALOG_PATH, JSON.stringify({ models }, null, 2));

  let backup: string | null = null;
  let original = "";
  if (existsSync(CODEX_CONFIG_PATH)) {
    original = readFileSync(CODEX_CONFIG_PATH, "utf8");
    backup = `${CODEX_CONFIG_PATH}.bak-ch-relay-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    copyFileSync(CODEX_CONFIG_PATH, backup);
  }
  const crlf = original.includes("\r\n");
  const next = remapSelectedModel(
    applyManaged(original.replace(/\r\n/g, "\n"), `http://127.0.0.1:${port}/v1`, CODEX_CATALOG_PATH),
    slugMap,
  );
  writeFileSync(CODEX_CONFIG_PATH, crlf ? next.replace(/\n/g, "\r\n") : next);

  return { catalogPath: CODEX_CATALOG_PATH, configPath: CODEX_CONFIG_PATH, models: models.length, backup };
}

export function unsyncCodex(): boolean {
  let changed = false;
  if (existsSync(CODEX_CONFIG_PATH)) {
    const raw = readFileSync(CODEX_CONFIG_PATH, "utf8");
    const crlf = raw.includes("\r\n");
    const next = stripManaged(raw.replace(/\r\n/g, "\n"));
    writeFileSync(CODEX_CONFIG_PATH, crlf ? next.replace(/\n/g, "\r\n") : next);
    changed = true;
  }
  if (existsSync(CODEX_AGENTS_PATH)) {
    const raw = readFileSync(CODEX_AGENTS_PATH, "utf8");
    const stripped = stripManagedMd(raw);
    if (stripped !== raw) writeFileSync(CODEX_AGENTS_PATH, stripped.trim() ? stripped : "");
  }
  return changed;
}
