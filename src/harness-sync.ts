// Sync ch-relay into non-Codex harnesses on this machine: ZCode, OpenCode,
// OMP (oh-my-pi), Pi. Each keeps its own config format — we merge a single
// "chrelay" provider entry, never rewrite the whole file, and back up first.
// Re-running is idempotent: our provider block is replaced, user entries stay.

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { providers } from "./providers/index.ts";
import { AUTO_REVIEW_SLUG } from "./providers/chatgpt/catalog.ts";
import { CODEX_HOME, DEFAULT_SHARE_PORT } from "./paths.ts";
import type { CatalogModel } from "./types.ts";

const PROVIDER_ID = "chrelay";
const PROVIDER_LABEL = "ch-relay (local)";

export interface HarnessResult {
  id: "zcode" | "opencode" | "omp" | "pi";
  name: string;
  status: "synced" | "skipped" | "error";
  path: string;
  models?: number;
  backup?: string;
  message?: string;
}

export interface HarnessSyncResult {
  baseUrl: string;
  results: HarnessResult[];
}

/**
 * The share endpoint only serves ChatGPT-lane models (other providers are
 * gated out in share/server.ts) — publish exactly that set.
 */
async function collectModels(): Promise<CatalogModel[]> {
  const models = await providers.chatgpt.models().catch(() => [] as CatalogModel[]);
  return models.filter((m) => !m.hidden && m.slug !== AUTO_REVIEW_SLUG);
}

/** Harnesses authenticate with the same ChatGPT access token Codex uses. */
function chatgptToken(): string | null {
  try {
    const auth = JSON.parse(readFileSync(join(CODEX_HOME, "auth.json"), "utf8")) as {
      tokens?: { access_token?: string };
      OPENAI_API_KEY?: string | null;
    };
    return auth.tokens?.access_token ?? auth.OPENAI_API_KEY ?? null;
  } catch {
    return null;
  }
}

function backupPath(file: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  return `${file}.bak-chrelay-${stamp}`;
}

function writeJson(file: string, data: unknown): string | null {
  let backup: string | null = null;
  if (existsSync(file)) {
    backup = backupPath(file);
    copyFileSync(file, backup);
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
  return backup;
}

const yq = (s: string) => `"${s.replace(/["\\]/g, (c) => `\\${c}`)}"`;

// ---------------------------------------------------------------------------
// ZCode — ~/.zcode/v2/provider_config.json (schemaVersion 1 rules format)
// ---------------------------------------------------------------------------

function syncZcode(baseUrl: string, apiKey: string, models: CatalogModel[]): Omit<HarnessResult, "id" | "name"> {
  const file = join(homedir(), ".zcode", "v2", "provider_config.json");
  if (!existsSync(dirname(file))) return { status: "skipped", path: file, message: "chưa cài" };

  const doc = existsSync(file)
    ? JSON.parse(readFileSync(file, "utf8"))
    : { schemaVersion: 1, config: {} };
  const cfg = (doc.config ??= {});
  const rules = (cfg.providerConfigRules ??= { providerRules: [] });
  rules.providerRules ??= [];
  const modelRules = (cfg.modelConfigRules ??= { providerModelRules: [], manualProviderModelRules: [] });
  modelRules.providerModelRules ??= [];

  const rule = {
    providerId: PROVIDER_ID,
    providerName: PROVIDER_LABEL,
    config: {
      group: "standard-personal",
      access: { type: "api-key", apiKey },
      api: { type: "openai-responses", baseUrl },
      personalModelIds: models.map((m) => m.slug),
      modelOrder: models.map((m) => m.slug),
    },
  };
  // An earlier hand-synced entry may point at our baseUrl under a different id
  // ("new-provider" etc.) — adopt it: rewrite in place, drop its model rules.
  const isOurs = (r: { providerId?: string; providerName?: string; config?: { api?: { baseUrl?: string } } }) =>
    r.providerId === PROVIDER_ID ||
    r.config?.api?.baseUrl === baseUrl ||
    /^ch-relay/i.test(r.providerName ?? "");
  const staleIds = new Set(rules.providerRules.filter(isOurs).map((r: { providerId?: string }) => r.providerId));
  const idx = rules.providerRules.findIndex(isOurs);
  rules.providerRules = rules.providerRules.filter((r: { providerId?: string }, i: number) => !isOurs(r) || i === idx);
  if (idx === -1) rules.providerRules.push(rule);
  else rules.providerRules[idx] = rule;

  cfg.providerOrder = [...new Set([...(cfg.providerOrder ?? []).map((id: string) => (staleIds.has(id) ? PROVIDER_ID : id)), PROVIDER_ID])];
  modelRules.providerModelRules = [
    ...modelRules.providerModelRules.filter((r: { providerId?: string }) => !staleIds.has(r.providerId)),
    ...models.map((m) => ({
      modelId: m.slug,
      providerId: PROVIDER_ID,
      config: {
        enabled: true,
        properties: { contextWindow: m.contextWindow || 128000 },
        optionSpecs: { maxOutputTokens: { max: Math.min(128000, m.contextWindow || 128000) } },
      },
    })),
  ];

  const backup = writeJson(file, doc);
  return { status: "synced", path: file, models: models.length, backup: backup ?? undefined };
}

// ---------------------------------------------------------------------------
// OpenCode — ~/.config/opencode/opencode.json (two provider spellings coexist)
// ---------------------------------------------------------------------------

function syncOpencode(baseUrl: string, apiKey: string, models: CatalogModel[]): Omit<HarnessResult, "id" | "name"> {
  const file = join(homedir(), ".config", "opencode", "opencode.json");
  if (!existsSync(file)) return { status: "skipped", path: file, message: "chưa cài" };

  const doc = JSON.parse(readFileSync(file, "utf8"));
  const modelMap = Object.fromEntries(
    models.map((m) => [
      m.slug,
      { name: `${m.slug} (ch-relay)`, limit: { context: m.contextWindow || 128000, output: Math.min(128000, m.contextWindow || 128000) } },
    ]),
  );
  if (doc.provider && typeof doc.provider === "object") {
    doc.provider[PROVIDER_ID] = {
      npm: "@ai-sdk/openai-compatible",
      name: PROVIDER_LABEL,
      options: { baseURL: baseUrl, apiKey },
      models: structuredClone(modelMap),
    };
  }
  if (doc.providers && typeof doc.providers === "object") {
    doc.providers[PROVIDER_ID] = {
      package: "@opencode-ai/ai/providers/openai-compatible",
      name: PROVIDER_LABEL,
      settings: { baseURL: baseUrl, apiKey },
      models: structuredClone(modelMap),
    };
  }
  if (!doc.provider && !doc.providers) doc.provider = { [PROVIDER_ID]: { npm: "@ai-sdk/openai-compatible", name: PROVIDER_LABEL, options: { baseURL: baseUrl, apiKey }, models: modelMap } };

  const backup = writeJson(file, doc);
  return { status: "synced", path: file, models: models.length, backup: backup ?? undefined };
}

// ---------------------------------------------------------------------------
// OMP — ~/.omp/agent/models.yml (pi-style provider schema, YAML text)
// Only one top-level key (`providers:`); our block lives at 2-space indent.
// ---------------------------------------------------------------------------

function ompModelYaml(m: CatalogModel): string[] {
  const lines = [`      - id: ${yq(m.slug)}`, `        name: ${yq(`${m.slug} (ch-relay)`)}`];
  const input = m.inputModalities.length ? m.inputModalities : ["text"];
  lines.push(`        input: [${input.join(", ")}]`);
  lines.push(`        contextWindow: ${m.contextWindow || 128000}`);
  lines.push(`        maxTokens: 32000`);
  if (m.reasoningLevels.length) {
    lines.push(`        reasoning: true`, `        thinking:`, `          mode: effort`, `          efforts: [${m.reasoningLevels.join(", ")}]`, `          defaultLevel: ${m.defaultReasoning || m.reasoningLevels[0]}`);
  }
  return lines;
}

function syncOmp(baseUrl: string, apiKey: string, models: CatalogModel[]): Omit<HarnessResult, "id" | "name"> {
  const dir = join(homedir(), ".omp", "agent");
  const file = join(dir, "models.yml");
  if (!existsSync(dir)) return { status: "skipped", path: file, message: "chưa cài" };

  const raw = existsSync(file) ? readFileSync(file, "utf8") : "providers:\n";
  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  // Drop our previous provider block: `  chrelay:` through the next 2-space key.
  const kept: string[] = [];
  let skipping = false;
  for (const line of lines) {
    if (/^  chrelay:/.test(line)) { skipping = true; continue; }
    if (skipping && (/^  \S/.test(line) || /^\S/.test(line))) skipping = false;
    if (!skipping) kept.push(line);
  }
  const hasProvidersRoot = kept.some((l) => /^providers:/.test(l));
  const body = hasProvidersRoot ? kept : ["providers:", ...kept];
  while (body.length && !body[body.length - 1]!.trim()) body.pop();

  const block = [
    `  ${PROVIDER_ID}:`,
    `    baseUrl: ${yq(baseUrl)}`,
    `    api: openai-responses`,
    `    apiKey: ${yq(apiKey)}`,
    `    models:`,
    ...models.flatMap(ompModelYaml),
  ];

  let backup: string | null = null;
  if (existsSync(file)) {
    backup = backupPath(file);
    copyFileSync(file, backup);
  }
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, [...body, ...block, ""].join("\n"));
  return { status: "synced", path: file, models: models.length, backup: backup ?? undefined };
}

// ---------------------------------------------------------------------------
// Pi — ~/.pi/agent/models.json (same provider schema as OMP, JSON form)
// ---------------------------------------------------------------------------

function syncPi(baseUrl: string, apiKey: string, models: CatalogModel[]): Omit<HarnessResult, "id" | "name"> {
  const file = join(homedir(), ".pi", "agent", "models.json");
  if (!existsSync(dirname(file))) return { status: "skipped", path: file, message: "chưa cài" };

  const doc = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : { providers: {} };
  doc.providers ??= {};
  doc.providers[PROVIDER_ID] = {
    baseUrl,
    api: "openai-responses",
    apiKey,
    models: models.map((m) => {
      const e: Record<string, unknown> = {
        id: m.slug,
        name: `${m.slug} (ch-relay)`,
        input: m.inputModalities.length ? m.inputModalities : ["text"],
      };
      e.contextWindow = m.contextWindow || 128000;
      e.maxTokens = 32000;
      if (m.reasoningLevels.length) {
        e.reasoning = true;
        e.thinking = { mode: "effort", efforts: m.reasoningLevels, defaultLevel: m.defaultReasoning || m.reasoningLevels[0] };
      }
      return e;
    }),
  };

  const backup = writeJson(file, doc);
  return { status: "synced", path: file, models: models.length, backup: backup ?? undefined };
}

// ---------------------------------------------------------------------------

export async function syncHarnesses(port: number): Promise<HarnessSyncResult> {
  // Customer installs run only the share listener — main port stays 0.
  const effective = port > 0 ? port : DEFAULT_SHARE_PORT || 11500;
  const baseUrl = `http://127.0.0.1:${effective}/v1`;
  const token = chatgptToken();
  const models = token ? await collectModels() : [];
  const results: HarnessResult[] = [];
  const jobs: Array<[HarnessResult["id"], string, () => Omit<HarnessResult, "id" | "name">]> = [
    ["zcode", "ZCode", () => syncZcode(baseUrl, token!, models)],
    ["opencode", "OpenCode", () => syncOpencode(baseUrl, token!, models)],
    ["omp", "OMP", () => syncOmp(baseUrl, token!, models)],
    ["pi", "Pi", () => syncPi(baseUrl, token!, models)],
  ];
  for (const [id, name, fn] of jobs) {
    try {
      if (!token) {
        results.push({ id, name, status: "skipped", path: "", message: "chưa đăng nhập Codex (không có ChatGPT token)" });
        continue;
      }
      if (models.length === 0) {
        results.push({ id, name, status: "skipped", path: "", message: "không có model nào" });
        continue;
      }
      results.push({ id, name, ...fn() });
    } catch (err) {
      results.push({ id, name, status: "error", path: "", message: err instanceof Error ? err.message : String(err) });
    }
  }
  return { baseUrl, results };
}
