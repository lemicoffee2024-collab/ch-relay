import { expect, test } from "bun:test";
import { buildChatgptCatalog, AUTO_REVIEW_SLUG, ASTRA_SLUG, wireEffort } from "../src/providers/chatgpt/catalog.ts";

test("astra is listed once as the first model; auto review stays off-catalog", () => {
  const cat = buildChatgptCatalog();
  expect(cat[0]!.slug).toBe(ASTRA_SLUG);
  const astra = cat.find((m) => m.slug === ASTRA_SLUG)!;
  expect(astra.display_name).toBe("GPT-6-Astra");
  expect(astra.visibility).toBe("list");
  expect(astra.model_messages).toBeDefined();
  expect(cat.filter((m) => m.slug === ASTRA_SLUG).length).toBe(1);
  expect(cat.some((m) => m.slug === AUTO_REVIEW_SLUG || m.slug === "codex-auto-review")).toBe(false);
});

test("ChatGPT catalog keeps context and compaction limits consistent", () => {
  const cat = buildChatgptCatalog();
  for (const entry of cat) {
    const context = entry.context_window;
    if (typeof context !== "number" || context <= 0) continue;
    expect(entry.max_context_window).toBe(context);
    expect(entry.auto_compact_token_limit).toBe(Math.floor(context * 0.9));
  }
});

test("auto review clamps Astra-only effort to what codex-auto-review accepts", () => {
  expect(wireEffort("codex-auto-review", "ultra")).toBe("max");
  expect(wireEffort("codex-auto-review", "xhigh")).toBe("xhigh");
  expect(wireEffort("gpt-6-astra", "ultra")).toBe("max");
  expect(wireEffort("codex-auto-review", undefined)).toBeUndefined();
});

test("catalog follows live upstream config but never offers Fast, websockets or a second Auto Review", () => {
  const cat = buildChatgptCatalog();
  expect(cat.some((m) => m.slug === "codex-auto-review")).toBe(false);
  expect(cat.find((m) => m.slug === "gpt-5.5")?.visibility).toBe("hide");
  for (const m of cat) {
    for (const f of ["service_tiers", "additional_speed_tiers", "default_service_tier", "prefer_websockets"]) expect(m[f]).toBeUndefined();
  }
  const astra = cat.find((m) => m.slug === ASTRA_SLUG)!;
  expect(astra.shell_type).toBe("shell_command");
  expect(astra.supports_reasoning_summaries).toBe(true);
  expect(astra.base_instructions).toBe((astra.model_messages as { instructions_template: string }).instructions_template);
});
