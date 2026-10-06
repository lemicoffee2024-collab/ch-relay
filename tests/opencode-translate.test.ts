import { beforeEach, describe, expect, test } from "bun:test";
import { useMemoryDb } from "../src/store/db.ts";
import { buildChatRequest, chatStreamEvents } from "../src/providers/opencode/chat.ts";
import { anthropicStreamEvents, buildAnthropicRequest } from "../src/providers/opencode/anthropic.ts";
import { buildResponsesRequest } from "../src/providers/opencode/responses.ts";
import { ToolMap, normalizeSchema } from "../src/providers/opencode/tools.ts";
import { chatReasoningFields, wireFor } from "../src/providers/opencode/models.ts";
import { MISSING_RESULT_TEXT } from "../src/providers/opencode/history.ts";
import { storeReasoning } from "../src/providers/opencode/reasoning-cache.ts";
import type { AdapterEvent } from "../src/lib/sse.ts";
import type { ResponsesRequest } from "../src/types.ts";

beforeEach(() => {
  useMemoryDb();
});

function sse(lines: string[]): ReadableStream<Uint8Array> {
  return new Response(lines.map((l) => `data: ${l}\n\n`).join("")).body!;
}

async function collect(gen: AsyncGenerator<AdapterEvent>): Promise<AdapterEvent[]> {
  const out: AdapterEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

const fnTool = {
  type: "function",
  name: "shell",
  description: "run a command",
  parameters: {
    type: "object",
    properties: { cmd: { type: ["string", "null"] }, timeout: { type: "number" } },
    required: [],
  },
};

describe("Responses -> Chat request", () => {
  test("system, developer, user text + image, tools", () => {
    const body: ResponsesRequest = {
      model: "opencode-go/kimi-k3",
      instructions: "BASE",
      input: [
        { type: "message", role: "developer", content: [{ type: "input_text", text: "DEV" }] },
        {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: "look" },
            { type: "input_image", image_url: "data:image/png;base64,AAAA" },
          ],
        },
      ],
      tools: [fnTool, { type: "web_search" }],
      tool_choice: "auto",
      parallel_tool_calls: true,
      temperature: 0.3,
    };
    const { request } = buildChatRequest(body, "kimi-k3", "medium");
    const msgs = request.messages as any[];
    expect(msgs[0]).toEqual({ role: "system", content: "BASE\n\nDEV" });
    expect(msgs[1].role).toBe("user");
    expect(msgs[1].content).toEqual([
      { type: "text", text: "look" },
      { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
    ]);
    const tools = request.tools as any[];
    expect(tools).toHaveLength(1); // hosted web_search dropped
    expect(tools[0].function.name).toBe("shell");
    expect(tools[0].function.parameters.properties.cmd.type).toBe("string");
    expect(tools[0].function.parameters.required).toBeUndefined();
    expect(request.tool_choice).toBe("auto");
    expect(request.parallel_tool_calls).toBe(true);
    // kimi-k3: no temperature, effort mapped medium -> high
    expect(request.temperature).toBeUndefined();
    expect(request.reasoning_effort).toBe("high");
    expect(request.stream_options).toEqual({ include_usage: true });
  });

  test("images are replaced for text-only models", () => {
    const { request } = buildChatRequest(
      {
        model: "x",
        input: [{ type: "message", role: "user", content: [{ type: "input_image", image_url: "https://x/y.png" }] }],
      },
      "glm-5.1",
      undefined,
    );
    const content = (request.messages as any[])[0].content;
    expect(JSON.stringify(content)).toContain("image omitted");
    expect(JSON.stringify(content)).not.toContain("image_url");
  });

  test("function_call / outputs pairing, missing output, orphan output, deferred user message", () => {
    const body: ResponsesRequest = {
      model: "x",
      input: [
        { type: "message", role: "user", content: "hi" },
        { type: "reasoning", summary: [{ type: "summary_text", text: "think A" }] },
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "calling" }] },
        { type: "function_call", call_id: "c1", name: "shell", arguments: '{"cmd":"ls"}' },
        { type: "function_call", call_id: "c2", name: "shell", arguments: '{"cmd":"pwd"}' },
        { type: "message", role: "user", content: "interrupt" },
        { type: "function_call_output", call_id: "c1", output: "files" },
        // c2 never gets an output
        { type: "function_call", call_id: "c3", name: "shell", arguments: "{}" },
        { type: "function_call_output", call_id: "c3", output: [{ type: "input_text", text: "ok" }] },
        { type: "function_call_output", call_id: "zz", output: "orphan" },
      ],
      tools: [fnTool],
    };
    const { request } = buildChatRequest(body, "deepseek-v4-flash", "high");
    const msgs = request.messages as any[];
    const roles = msgs.map((m) => m.role);
    expect(roles).toEqual(["user", "assistant", "tool", "tool", "user", "assistant", "tool", "assistant", "tool"]);
    expect(msgs[1].content).toBe("calling");
    expect(msgs[1].tool_calls.map((t: any) => t.id)).toEqual(["c1", "c2"]);
    expect(msgs[1].reasoning_content).toBe("think A");
    expect(msgs[2]).toEqual({ role: "tool", tool_call_id: "c1", content: "files" });
    expect(msgs[3]).toEqual({ role: "tool", tool_call_id: "c2", content: MISSING_RESULT_TEXT });
    expect(msgs[4].content).toBe("interrupt");
    // deepseek: tool-call turn without recorded reasoning gets the placeholder
    expect(msgs[5].reasoning_content).toBe(" ");
    expect(msgs[6].content).toBe("ok");
    expect(msgs[7].tool_calls[0]).toEqual({ id: "zz", type: "function", function: { name: "tool_result", arguments: "{}" } });
    expect(msgs[8]).toEqual({ role: "tool", tool_call_id: "zz", content: "orphan" });
    expect(request.reasoning_effort).toBe("high");
  });

  test("reasoning_content replayed from the call-id cache; not sent for non-preserve models", () => {
    storeReasoning(["c9"], { text: "cached thought" });
    const body: ResponsesRequest = {
      model: "x",
      input: [
        { type: "message", role: "user", content: "hi" },
        { type: "function_call", call_id: "c9", name: "shell", arguments: "{}" },
        { type: "function_call_output", call_id: "c9", output: "done" },
      ],
    };
    const a = buildChatRequest(body, "glm-5.3", undefined).request.messages as any[];
    expect(a[1].reasoning_content).toBe("cached thought");
    const b = buildChatRequest(body, "qwen3.8-max", undefined).request.messages as any[];
    expect(b[1].reasoning_content).toBeUndefined();
  });

  test("custom and namespaced tools round-trip through wire names", () => {
    const body: ResponsesRequest = {
      model: "x",
      input: [
        { type: "message", role: "user", content: "go" },
        { type: "custom_tool_call", call_id: "k1", name: "apply_patch", input: "*** Begin Patch" },
        { type: "custom_tool_call_output", call_id: "k1", output: "patched" },
        { type: "function_call", call_id: "k2", name: "search", namespace: "mcp_docs", arguments: '{"q":"x"}' },
        { type: "function_call_output", call_id: "k2", output: "hits" },
      ],
      tools: [
        { type: "custom", name: "apply_patch", description: "patch", format: { type: "grammar", syntax: "lark", definition: "start: x" } },
        {
          type: "namespace",
          name: "mcp_docs",
          tools: [{ type: "function", name: "search", parameters: { type: "object", properties: { q: { type: "string" } } } }],
        },
      ],
    };
    const { request, tools } = buildChatRequest(body, "glm-5.1", undefined);
    const names = (request.tools as any[]).map((t) => t.function.name);
    expect(names).toEqual(["apply_patch", "mcp_docs__search"]);
    expect((request.tools as any[])[0].function.parameters.required).toEqual(["input"]);
    const msgs = request.messages as any[];
    expect(msgs[1].tool_calls[0].function).toEqual({ name: "apply_patch", arguments: '{"input":"*** Begin Patch"}' });
    expect(msgs[3].tool_calls[0].function.name).toBe("mcp_docs__search");
    expect(tools.resolve("mcp_docs__search")).toEqual({ name: "search", namespace: "mcp_docs", custom: false });
    expect(tools.resolve("mcp_docs.search").name).toBe("search");
    expect(tools.resolve("apply_patch").custom).toBe(true);
  });

  test("json_schema downgraded for deepseek; tool_choice restricted for kimi-k2.7-code", () => {
    const body: ResponsesRequest = {
      model: "x",
      input: "hi",
      text: { format: { type: "json_schema", name: "r", schema: { type: "object" }, strict: true } },
      tools: [fnTool],
      tool_choice: "required",
    };
    expect(buildChatRequest(body, "deepseek-v4-pro", undefined).request.response_format).toEqual({ type: "json_object" });
    expect((buildChatRequest(body, "glm-5.3", undefined).request.response_format as any).type).toBe("json_schema");
    const k = buildChatRequest(body, "kimi-k2.7-code", "high").request;
    expect(k.tool_choice).toBe("auto");
    expect(k.reasoning_effort).toBeUndefined();
  });

  test("per-model effort quirks", () => {
    expect(chatReasoningFields("glm-5.1", "low")).toEqual({ thinking: { type: "disabled" } });
    expect(chatReasoningFields("mimo-v2.5-pro", "high")).toEqual({ thinking: { type: "enabled" } });
    expect(chatReasoningFields("qwen3.6-plus", "medium")).toEqual({ thinking_budget: 16384 });
    expect(chatReasoningFields("qwen3.7-max", "max", 10000)).toEqual({ thinking_budget: 10000 });
    expect(chatReasoningFields("deepseek-v4-pro", "xhigh")).toEqual({ reasoning_effort: "high" });
    expect(chatReasoningFields("kimi-k2.7-code", "high")).toEqual({});
    expect(chatReasoningFields("glm-5.3", "medium")).toEqual({ reasoning_effort: "low" });
    expect(chatReasoningFields("glm-5.3", undefined)).toEqual({});
  });

  test("schema normalization flattens root combinators", () => {
    const s = normalizeSchema({ anyOf: [{ properties: { a: { type: "string" } } }, { properties: { b: { type: "integer" } } }] });
    expect(s.type).toBe("object");
    expect(Object.keys(s.properties as object)).toEqual(["a", "b"]);
    expect(normalizeSchema(undefined)).toEqual({ type: "object", properties: {} });
  });

  test("wire selection", () => {
    expect(wireFor("opencode-go", "gpt-5.6-luna")).toBe("responses");
    expect(wireFor("opencode-go", "muse-spark-1.3-contributor")).toBe("responses");
    expect(wireFor("opencode-go", "minimax-m2.7")).toBe("anthropic");
    expect(wireFor("opencode-go", "glm-5.1")).toBe("chat");
    expect(wireFor("opencode-zen", "claude-sonnet-5")).toBe("anthropic");
    expect(wireFor("opencode-zen", "gpt-5.5")).toBe("responses");
    expect(wireFor("opencode-zen", "kimi-k3")).toBe("chat");
  });
});

describe("Chat stream -> AdapterEvents", () => {
  const tools = new ToolMap([fnTool, { type: "custom", name: "apply_patch" }]);

  test("text, reasoning, tool calls across chunks, usage", async () => {
    const chunks = [
      { choices: [{ index: 0, delta: { reasoning_content: "hmm " } }] },
      { choices: [{ index: 0, delta: { reasoning_content: "ok" } }] },
      { choices: [{ index: 0, delta: { content: "Hello" } }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_a", function: { name: "shell", arguments: '{"cm' } }] } }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: 'd":"ls"}' } }] } }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 1, id: "call_b", function: { name: "apply_patch", arguments: '{"input":"P"}' } }] } }] },
      { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
      { choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 40 }, completion_tokens_details: { reasoning_tokens: 5 } } },
    ].map((c) => JSON.stringify(c));
    const events = await collect(chatStreamEvents(sse([...chunks, "[DONE]"]), tools));
    expect(events.map((e) => e.type)).toEqual([
      "reasoning_delta",
      "reasoning_delta",
      "text_delta",
      "tool_call",
      "tool_call",
      "usage",
      "finish",
    ]);
    const call = events[3] as Extract<AdapterEvent, { type: "tool_call" }>;
    expect(call).toMatchObject({ callId: "call_a", name: "shell", arguments: '{"cmd":"ls"}' });
    const custom = events[4] as Extract<AdapterEvent, { type: "tool_call" }>;
    expect(custom.extra).toMatchObject({ type: "custom_tool_call", name: "apply_patch", input: "P" });
    expect(events[5]).toEqual({
      type: "usage",
      usage: { inputTokens: 100, outputTokens: 20, cachedInputTokens: 40, reasoningOutputTokens: 5 },
    });
    expect(events[6]).toEqual({ type: "finish", reason: "stop" });
    // reasoning recorded for replay
    const { loadReasoning } = await import("../src/providers/opencode/reasoning-cache.ts");
    expect(loadReasoning("call_a")?.text).toBe("hmm ok");
  });

  test("finish_reason length -> incomplete", async () => {
    const events = await collect(
      chatStreamEvents(
        sse([JSON.stringify({ choices: [{ delta: { content: "abc" }, finish_reason: "length" }] }), "[DONE]"]),
        tools,
      ),
    );
    expect(events.at(-1)).toEqual({ type: "finish", reason: "length" });
  });

  test("EOF tolerance: complete tool call without finish_reason or [DONE]", async () => {
    const events = await collect(
      chatStreamEvents(
        sse([JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "c", function: { name: "shell", arguments: "{}" } }] } }] })]),
        tools,
      ),
    );
    expect(events.map((e) => e.type)).toEqual(["tool_call", "finish"]);
  });

  test("truncated text stream without terminal -> error", async () => {
    const events = await collect(chatStreamEvents(sse([JSON.stringify({ choices: [{ delta: { content: "par" } }] })]), tools));
    expect(events.at(-1)?.type).toBe("error");
  });

  test("[DONE] without finish_reason completes; invalid tool args fail", async () => {
    const ok = await collect(chatStreamEvents(sse([JSON.stringify({ choices: [{ delta: { content: "x" } }] }), "[DONE]"]), tools));
    expect(ok.at(-1)).toEqual({ type: "finish", reason: "stop" });
    const bad = await collect(
      chatStreamEvents(
        sse([
          JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "c", function: { name: "shell", arguments: "{bad" } }] }, finish_reason: "tool_calls" }] }),
          "[DONE]",
        ]),
        tools,
      ),
    );
    expect(bad.at(-1)?.type).toBe("error");
  });

  test("chunk.error -> error", async () => {
    const events = await collect(chatStreamEvents(sse([JSON.stringify({ error: { message: "boom" } })]), tools));
    expect(events).toEqual([{ type: "error", message: "boom", code: "upstream_error" }]);
  });
});

describe("Anthropic wire", () => {
  test("request translation", () => {
    storeReasoning(["t1"], { text: "th", blocks: [{ thinking: "th", signature: "sig-abcdefghijklmnop" }] });
    const { request } = buildAnthropicRequest(
      {
        model: "x",
        instructions: "SYS",
        input: [
          { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }, { type: "input_image", image_url: "data:image/png;base64,QUJD" }] },
          { type: "function_call", call_id: "t1", name: "shell", arguments: '{"cmd":"ls"}' },
          { type: "function_call_output", call_id: "t1", output: "out" },
        ],
        tools: [fnTool],
        tool_choice: "required",
      },
      "minimax-m3",
      "high",
    );
    expect(request.system).toBe("SYS");
    const msgs = request.messages as any[];
    expect(msgs[0].content[1]).toEqual({ type: "image", source: { type: "base64", media_type: "image/png", data: "QUJD" } });
    expect(msgs[1].content[0]).toEqual({ type: "thinking", thinking: "th", signature: "sig-abcdefghijklmnop" });
    expect(msgs[1].content[1]).toEqual({ type: "tool_use", id: "t1", name: "shell", input: { cmd: "ls" } });
    expect(msgs[2].content[0]).toEqual({ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "out" }] });
    expect((request.tools as any[])[0].input_schema.type).toBe("object");
    expect(request.tool_choice).toEqual({ type: "any" });
    expect(request.thinking).toBeUndefined(); // minimax: no thinking knob
  });

  test("stream translation", async () => {
    const tools = new ToolMap([fnTool]);
    const ev = [
      { type: "message_start", message: { usage: { input_tokens: 10, cache_read_input_tokens: 5, output_tokens: 1 } } },
      { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "plan" } },
      { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "SIG" } },
      { type: "content_block_stop", index: 0 },
      { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Hi" } },
      { type: "content_block_stop", index: 1 },
      { type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "tu1", name: "shell", input: {} } },
      { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: '{"cmd"' } },
      { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: ':"ls"}' } },
      { type: "content_block_stop", index: 2 },
      { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 30 } },
      { type: "message_stop" },
    ];
    const events = await collect(anthropicStreamEvents(sse(ev.map((e) => JSON.stringify(e))), tools));
    expect(events.map((e) => e.type)).toEqual(["reasoning_delta", "text_delta", "tool_call", "usage", "finish"]);
    expect(events[2]).toMatchObject({ callId: "tu1", name: "shell", arguments: '{"cmd":"ls"}' });
    expect(events[3]).toEqual({ type: "usage", usage: { inputTokens: 15, outputTokens: 30, cachedInputTokens: 5 } });
    const { loadReasoning } = await import("../src/providers/opencode/reasoning-cache.ts");
    expect(loadReasoning("tu1")?.blocks).toEqual([{ thinking: "plan", signature: "SIG" }]);
  });
});

describe("Responses wire (stateless passthrough)", () => {
  test("strips state, ids, hosted tools; flattens namespaces; drops unreplayable reasoning", () => {
    const { request, mapping } = buildResponsesRequest(
      {
        model: "opencode-go/gpt-5.6-luna",
        previous_response_id: "resp_1",
        service_tier: "priority",
        store: true,
        include: ["reasoning.encrypted_content"],
        reasoning: { effort: "high", summary: "auto" },
        input: [
          { type: "message", role: "user", id: "msg_1", content: "hi" },
          { type: "reasoning", id: "rs_1", summary: [{ type: "summary_text", text: "x" }] },
          { type: "reasoning", id: "rs_2", summary: [], encrypted_content: "ENC" },
          { type: "function_call", id: "fc_1", call_id: "c1", name: "search", namespace: "mcp", arguments: "{}" },
        ],
        tools: [
          { type: "web_search" },
          { type: "namespace", name: "mcp", tools: [{ type: "function", name: "search", parameters: {} }] },
          { type: "namespace", name: "functions", tools: [{ type: "custom", name: "exec" }] },
        ],
      },
      "gpt-5.6-luna",
      "high",
    );
    expect(request.previous_response_id).toBeUndefined();
    expect(request.service_tier).toBeUndefined();
    expect(request.store).toBe(false);
    expect(request.stream).toBe(true);
    const input = request.input as any[];
    expect(input.map((i) => i.type)).toEqual(["message", "reasoning", "function_call"]);
    expect(input.every((i) => i.id === undefined)).toBe(true);
    expect(input[2].name).toBe("mcp__search");
    expect(input[2].namespace).toBeUndefined();
    expect((request.tools as any[]).map((t) => t.name)).toEqual(["mcp__search", "exec"]);
    expect(mapping.names.get("mcp__search")).toEqual({ name: "search", namespace: "mcp" });
    expect(request.reasoning).toEqual({ effort: "high", summary: "auto" });
  });
});
