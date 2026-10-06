import { beforeEach, expect, test } from "bun:test";
import { useMemoryDb } from "../src/store/db.ts";
import { upsertAccount, listAccounts } from "../src/store/accounts.ts";
import { pickAccount, coolDown } from "../src/pool.ts";
import { ResponsesStreamBuilder, parseSse } from "../src/lib/sse.ts";
import { applyManaged, stripManaged, MARKER, routedEntry } from "../src/codex-sync.ts";
import {
  compactionV2Response,
  decodeSummary,
  encodeSummary,
  isCompactionTrigger,
  rewriteCompactionItems,
  summarizerRequest,
  collectText,
} from "../src/compaction.ts";
import { route } from "../src/router.ts";

beforeEach(() => {
  useMemoryDb();
});

function events(sse: string) {
  return sse
    .split("\n\n")
    .filter(Boolean)
    .map((b) => JSON.parse(b.split("\n").find((l) => l.startsWith("data: "))!.slice(6)));
}

test("stream builder emits well-formed Responses events", () => {
  const b = new ResponsesStreamBuilder("m");
  let s = "";
  s += b.push({ type: "reasoning_delta", text: "think" });
  s += b.push({ type: "text_delta", text: "Hel" });
  s += b.push({ type: "text_delta", text: "lo" });
  s += b.push({ type: "tool_call", callId: "call_1", name: "shell", arguments: '{"cmd":"ls"}', extra: { x: 1 } });
  s += b.push({ type: "usage", usage: { inputTokens: 10, outputTokens: 5, cachedInputTokens: 4 } });
  s += b.push({ type: "finish", reason: "stop" });
  const evs = events(s);
  expect(evs[0].type).toBe("response.created");
  expect(evs.map((e) => e.sequence_number)).toEqual(evs.map((_, i) => i));
  const done = evs.at(-1);
  expect(done.type).toBe("response.completed");
  expect(done.response.output.map((o: any) => o.type)).toEqual(["reasoning", "message", "function_call"]);
  expect(done.response.output[1].content[0].text).toBe("Hello");
  expect(done.response.output[2]).toMatchObject({ call_id: "call_1", arguments: '{"cmd":"ls"}', x: 1 });
  expect(done.response.usage).toMatchObject({ input_tokens: 10, output_tokens: 5, total_tokens: 15, input_tokens_details: { cached_tokens: 4 } });
  // output_index values are consecutive
  const added = evs.filter((e) => e.type === "response.output_item.added").map((e) => e.output_index);
  expect(added).toEqual([0, 1, 2]);
});

test("stream builder: length finish -> incomplete, error -> failed", () => {
  const b = new ResponsesStreamBuilder("m");
  const s = b.push({ type: "text_delta", text: "x" }) + b.push({ type: "finish", reason: "length" });
  expect(events(s).at(-1)).toMatchObject({ type: "response.incomplete", response: { incomplete_details: { reason: "max_output_tokens" } } });
  const c = new ResponsesStreamBuilder("m");
  expect(events(c.push({ type: "error", message: "boom" })).at(-1).type).toBe("response.failed");
});

test("parseSse handles CRLF, comments and multi-line data", async () => {
  const raw = ": ping\r\nevent: a\r\ndata: {\"x\":\r\ndata: 1}\r\n\r\ndata: [DONE]\n\n";
  const stream = new Response(raw).body!;
  const frames = [];
  for await (const f of parseSse(stream)) frames.push(f);
  expect(frames).toEqual([{ event: "a", data: '{"x":\n1}' }, { event: undefined, data: "[DONE]" }]);
});

test("router maps slugs to providers", () => {
  expect(route("gpt-6-sol")).toEqual({ provider: "chatgpt", model: "gpt-6-sol" });
  expect(route("openai/codex-auto-review")).toEqual({ provider: "chatgpt", model: "codex-auto-review" });
  expect(route("google-antigravity/gemini-3.1-pro")).toEqual({ provider: "antigravity", model: "gemini-3.1-pro" });
  expect(route("opencode-go/kimi-k3")).toEqual({ provider: "opencode-go", model: "kimi-k3" });
});

test("pool prefers priority, skips cooled accounts, keeps affinity", () => {
  const a = upsertAccount({ provider: "chatgpt", label: "a", credential: {} });
  const b = upsertAccount({ provider: "chatgpt", label: "b", credential: {}, priority: 5 });
  expect(pickAccount("chatgpt")!.id).toBe(b.id);
  coolDown(b.id, "*", 60_000, "429");
  expect(pickAccount("chatgpt", { sessionKey: "s1" })!.id).toBe(a.id);
  // affinity holds even though b is available again later? b still cooling -> a
  expect(pickAccount("chatgpt", { sessionKey: "s1" })!.id).toBe(a.id);
  expect(pickAccount("chatgpt", { exclude: new Set([a.id]) })).toBeNull();
  expect(listAccounts("chatgpt").length).toBe(2);
});

test("pool avoids accounts over the usage threshold", () => {
  const a = upsertAccount({ provider: "chatgpt", label: "a", credential: {} });
  const b = upsertAccount({ provider: "chatgpt", label: "b", credential: {} });
  const scores: Record<string, number> = { [a.id]: 95, [b.id]: 20 };
  expect(pickAccount("chatgpt", { score: (x) => scores[x.id], threshold: 90 })!.id).toBe(b.id);
});

test("upsert dedupes by email", () => {
  const a = upsertAccount({ provider: "chatgpt", label: "x", email: "A@x.com", credential: { t: 1 } }, { email: "A@x.com" });
  const b = upsertAccount({ provider: "chatgpt", label: "x", email: "a@x.com", credential: { t: 2 } }, { email: "a@x.com" });
  expect(b.id).toBe(a.id);
  expect(b.credential).toEqual({ t: 2 });
});

test("codex config: takes over opencodex keys, keeps user keys, idempotent, reversible", () => {
  const orig = [
    'model_catalog_json = "C:/x/native.json"',
    'model = "gpt-6-sol"',
    "# Auto-injected by opencodex (undo: ocx restore)",
    'openai_base_url = "http://127.0.0.1:10101/v1"',
    "# Auto-injected by opencodex (undo: ocx restore)",
    'experimental_realtime_ws_base_url = "http://127.0.0.1:10101/v1"',
    "",
    "[features]",
    "x = true",
  ].join("\n");
  const once = applyManaged(orig, "http://127.0.0.1:10200/v1", "C:\\Users\\me\\.codex\\ch-relay-catalog.json");
  const twice = applyManaged(once, "http://127.0.0.1:10200/v1", "C:\\Users\\me\\.codex\\ch-relay-catalog.json");
  expect(twice).toBe(once);
  expect(once).not.toContain("10101");
  expect(once).not.toContain("opencodex");
  expect(once).toContain('openai_base_url = "http://127.0.0.1:10200/v1"');
  expect(once).toContain('model_catalog_json = "C:/Users/me/.codex/ch-relay-catalog.json"');
  expect(once).toContain('model = "gpt-6-sol"');
  // root keys must stay before the first table
  expect(once.indexOf("openai_base_url")).toBeLessThan(once.indexOf("[features]"));
  const stripped = stripManaged(once);
  expect(stripped).not.toContain(MARKER);
  expect(stripped).toContain("[features]");
});

test("routed catalog entry has Codex strict fields", () => {
  const e = routedEntry({
    slug: "google-antigravity/gemini-3.1-pro",
    displayName: "agy/gemini-3.1-pro",
    provider: "antigravity",
    contextWindow: 1_000_000,
    reasoningLevels: ["low", "high"],
    defaultReasoning: "high",
    inputModalities: ["text", "image"],
  });
  for (const k of ["slug", "display_name", "shell_type", "base_instructions", "truncation_policy", "apply_patch_tool_type", "supported_reasoning_levels"])
    expect(e[k]).toBeDefined();
  expect(e.max_context_window).toBe(1_000_000);
  expect(e.auto_compact_token_limit).toBe(900_000);
  expect(e.opencodex_capability_provenance).toBeUndefined();
});

test("compaction helpers", async () => {
  const blob = encodeSummary("tóm tắt");
  expect(decodeSummary(blob)).toBe("tóm tắt");
  const body = {
    model: "google-antigravity/x",
    tools: [{ type: "function" }],
    input: [
      { type: "compaction", encrypted_content: blob },
      { type: "compaction", encrypted_content: "gAAAA-real-openai" },
      { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
      { type: "compaction_trigger" },
    ],
  };
  expect(isCompactionTrigger(body)).toBe(true);
  const routed = rewriteCompactionItems(body, true);
  expect((routed.input as any[])[0].content[0].text).toContain("tóm tắt");
  expect((routed.input as any[])[1].content[0].text).toContain("cannot read");
  const native = rewriteCompactionItems(body, false);
  expect((native.input as any[])[1].type).toBe("compaction"); // real blob untouched
  const s = summarizerRequest(routed);
  expect(s.tools).toBeUndefined();
  expect((s.input as any[]).some((i) => i.type === "compaction_trigger")).toBe(false);

  const res = compactionV2Response("m", "sum", { inputTokens: 1, outputTokens: 2 });
  const text = await res.text();
  const evs = events(text);
  const items = evs.filter((e) => e.type === "response.output_item.done");
  expect(items.length).toBe(1);
  expect(decodeSummary(items[0].item.encrypted_content)).toBe("sum");

  const b = new ResponsesStreamBuilder("m");
  const sse = b.push({ type: "text_delta", text: "abc" }) + b.push({ type: "finish", reason: "stop" });
  expect((await collectText(new Response(sse))).text).toBe("abc");
});
