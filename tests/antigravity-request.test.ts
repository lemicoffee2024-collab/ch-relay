import { beforeEach, expect, test } from "bun:test";
import { useMemoryDb } from "../src/store/db.ts";
import { buildCcaRequest, sessionIdFrom } from "../src/providers/antigravity/request.ts";
import { resolveWireModel } from "../src/providers/antigravity/models.ts";
import { sanitizeToolSchema } from "../src/providers/antigravity/schema.ts";
import { THOUGHT_SIGNATURE_BYPASS } from "../src/providers/antigravity/signatures.ts";
import type { ResponsesRequest } from "../src/types.ts";

beforeEach(() => {
  useMemoryDb();
});

const shellTool = {
  type: "function",
  name: "shell",
  description: "Run a command",
  parameters: {
    $schema: "http://json-schema.org/draft-07/schema#",
    type: "object",
    additionalProperties: false,
    properties: {
      command: { type: "array", items: { type: "string", pattern: "^x" } },
      timeout_ms: { type: ["integer", "null"] },
      mode: { anyOf: [{ const: "a" }, { const: "b" }] },
    },
    required: ["command", "ghost"],
  },
};

function req(input: ResponsesRequest["input"], extra: Partial<ResponsesRequest> = {}): ResponsesRequest {
  return { model: "google-antigravity/gemini-3.8-flash", instructions: "BASE", input, tools: [shellTool], ...extra };
}

test("effort → wire model mapping", () => {
  expect(resolveWireModel("gemini-3.8-flash", undefined)).toEqual({ wire: "gemini-3.8-flash-medium" });
  expect(resolveWireModel("gemini-3.8-flash", "high")).toEqual({ wire: "gemini-3.8-flash-high" });
  expect(resolveWireModel("gemini-3.7-flash", "low")).toEqual({ wire: "gemini-3.7-flash-tiered", thinkingLevel: "low" });
  expect(resolveWireModel("gemini-3.1-pro", "low")).toEqual({ wire: "gemini-3.1-pro-low", thinkingLevel: "low" });
  expect(resolveWireModel("gemini-3.1-pro", "medium").wire).toBe("gemini-pro-agent");
  expect(resolveWireModel("claude-sonnet-4-6", "max")).toEqual({ wire: "claude-sonnet-4-6", thinkingLevel: "high" });
  expect(resolveWireModel("gpt-oss-120b-medium", "high")).toEqual({ wire: "gpt-oss-120b-medium" });
});

test("session id is stable, masked uint63 with '-' prefix", () => {
  const a = sessionIdFrom("codex-thread:abc");
  expect(a).toBe(sessionIdFrom("codex-thread:abc"));
  expect(a).toMatch(/^-\d+$/);
  expect(BigInt(a.slice(1)) < 2n ** 63n).toBe(true);
});

test("schema sanitization drops unsupported keywords", () => {
  const s = sanitizeToolSchema(shellTool.parameters) as any;
  expect(s.$schema).toBeUndefined();
  expect(s.additionalProperties).toBeUndefined();
  expect(s.properties.command.items.pattern).toBeUndefined();
  expect(s.properties.timeout_ms).toEqual({ type: "integer", nullable: true });
  expect(s.properties.mode).toEqual({ type: "string", enum: ["a", "b"] });
  expect(s.required).toEqual(["command"]);
  const withRef = sanitizeToolSchema({ type: "object", properties: { p: { $ref: "#/$defs/P" } }, $defs: { P: { type: "string", description: "d" } } }) as any;
  expect(withRef.properties.p).toEqual({ type: "string", description: "d" });
});

test("translates system prompt, messages, images, tool calls and outputs", () => {
  const built = buildCcaRequest(
    req([
      { type: "message", role: "developer", content: [{ type: "input_text", text: "dev note" }] },
      { type: "message", role: "system", content: "SYS2" },
      {
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: "look at this" },
          { type: "input_image", image_url: "data:image/png;base64,AAAA" },
          { type: "input_image", image_url: "https://example.com/x.png" },
        ],
      },
      { type: "reasoning", summary: [{ type: "summary_text", text: "thinking" }] },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "Running it" }] },
      { type: "function_call", call_id: "call_1", name: "shell", arguments: '{"command":["ls"]}' },
      { type: "function_call", call_id: "call.2", name: "shell", arguments: '{"command":["pwd"]}' },
      { type: "function_call_output", call_id: "call_1", output: "file.txt" },
    ]),
    "gemini-3.8-flash",
    "high",
    "thread-1",
  );
  const r = built.request as any;
  expect(built.wire).toBe("gemini-3.8-flash-high");
  expect(r.systemInstruction.parts[0].text).toBe("BASE\n\nSYS2");
  expect(r.sessionId).toBe(sessionIdFrom("codex-thread:thread-1"));
  expect(r.contents[0]).toEqual({ role: "user", parts: [{ text: "dev note" }] });
  expect(r.contents[1].parts).toEqual([
    { text: "look at this" },
    { inline_data: { mime_type: "image/png", data: "AAAA" } },
    { text: "[image: https://example.com/x.png]" },
  ]);
  const model = r.contents[2];
  expect(model.role).toBe("model");
  expect(model.parts[0]).toEqual({ text: "Running it" });
  expect(model.parts[1].functionCall).toEqual({ name: "shell", args: { command: ["ls"] }, id: "call_1" });
  // No stored signature: gemini gets the sentinel on the first call of the turn only.
  expect(model.parts[1].thoughtSignature).toBe(THOUGHT_SIGNATURE_BYPASS);
  expect(model.parts[2].thoughtSignature).toBeUndefined();
  expect(model.parts[2].functionCall.id).toBe("call_2");
  const tool = r.contents[3];
  expect(tool.role).toBe("user");
  expect(tool.parts[0]).toEqual({ functionResponse: { name: "shell", id: "call_1", response: { result: "file.txt" } } });
  expect(tool.parts[1].functionResponse.response.result).toBe("[missing tool_result for this tool_use in history]");
  expect(r.contents.length).toBe(4);
  expect(r.tools[0].functionDeclarations[0].name).toBe("shell");
  expect(r.toolConfig).toBeUndefined();
  expect(r.generationConfig).toEqual({ maxOutputTokens: 65536, thinkingConfig: { includeThoughts: true } });
});

test("ends with (continue) after a model turn; empty user → (empty)", () => {
  const built = buildCcaRequest(
    req([
      { type: "message", role: "user", content: [] },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "hi" }] },
    ]),
    "gemini-3.8-flash",
    undefined,
    undefined,
  );
  const c = (built.request as any).contents;
  expect(c[0].parts).toEqual([{ text: "(empty)" }]);
  expect(c[c.length - 1]).toEqual({ role: "user", parts: [{ text: "(continue)" }] });
});

test("claude: VALIDATED mode, thinkingLevel, no sentinel, none removes tools", () => {
  const input = [
    { type: "message", role: "user", content: "hi" },
    { type: "function_call", call_id: "c1", name: "shell", arguments: "{}" },
    { type: "function_call_output", call_id: "c1", output: [{ type: "input_text", text: "ok" }] },
  ];
  const built = buildCcaRequest(req(input, { tool_choice: "required" }), "claude-sonnet-4-6", "high", "s");
  const r = built.request as any;
  expect(built.family).toBe("cla");
  expect(r.toolConfig).toEqual({ functionCallingConfig: { mode: "VALIDATED" } });
  expect(r.generationConfig.thinkingConfig).toEqual({ thinkingLevel: "high" });
  expect(r.generationConfig.maxOutputTokens).toBe(64000);
  expect(r.contents[1].parts[0].thoughtSignature).toBeUndefined();
  expect(r.contents[2].parts[0].functionResponse.response.result).toBe("ok");
  const none = buildCcaRequest(req(input, { tool_choice: "none" }), "claude-sonnet-4-6", "high", "s").request as any;
  expect(none.tools).toBeUndefined();
  expect(none.toolConfig).toBeUndefined();
});

test("tool names are encoded and tool_choice maps", () => {
  const built = buildCcaRequest(
    req([{ type: "message", role: "user", content: "x" }], {
      tools: [{ type: "function", name: "mcp.server/tool name", parameters: { type: "object" } }, { type: "custom", name: "apply_patch", description: "patch", format: { type: "grammar", syntax: "lark", definition: "start: x" } }],
      tool_choice: { type: "function", name: "mcp.server/tool name" },
    }),
    "gemini-3.8-flash",
    undefined,
    undefined,
  );
  const decls = (built.request as any).tools[0].functionDeclarations;
  expect(decls[0].name).toMatch(/^mcp_server_tool_name_[0-9a-f]{8}$/);
  expect(built.codec.fromWire(decls[0].name)).toBe("mcp.server/tool name");
  expect(decls[1].parameters.required).toEqual(["input"]);
  expect(decls[1].description).toContain("start: x");
  expect((built.request as any).toolConfig).toEqual({ functionCallingConfig: { mode: "ANY", allowedFunctionNames: [decls[0].name] } });
});

test("gemini flash strips the Claude Agent SDK paragraph", () => {
  const built = buildCcaRequest(
    req("hi", { instructions: "You are a Claude agent, built on Anthropic's Claude Agent SDK.\n\nReal prompt" }),
    "gemini-3.7-flash",
    undefined,
    undefined,
  );
  expect((built.request as any).systemInstruction.parts[0].text).toBe("Real prompt");
});
