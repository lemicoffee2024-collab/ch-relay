import { afterEach, beforeEach, expect, test } from "bun:test";
import { useMemoryDb } from "../src/store/db.ts";
import { getAccount, isCooling, upsertAccount } from "../src/store/accounts.ts";
import { antigravityProvider } from "../src/providers/antigravity/index.ts";
import type { ProviderContext, RequestOutcome, ResponsesRequest } from "../src/types.ts";

const SIG = "c2lnbmF0dXJlLWJsb2ItMTIzNDU2Nzg5MA==";
const realFetch = globalThis.fetch;

interface Call {
  url: string;
  auth: string | null;
  ua: string | null;
  body: any;
}
let calls: Call[] = [];

function mockFetch(handler: (c: Call) => Response | Promise<Response>) {
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = typeof input === "string" ? input : input.url;
    const headers = new Headers(init?.headers);
    let body: any = init?.body;
    try {
      body = typeof body === "string" ? JSON.parse(body) : body;
    } catch {
      /* form body */
    }
    const c: Call = { url, auth: headers.get("authorization"), ua: headers.get("user-agent"), body };
    calls.push(c);
    return handler(c);
  }) as typeof fetch;
}

function sseBody(frames: unknown[]): Response {
  return new Response(frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
}

function addAccount(email: string, priority = 0) {
  return upsertAccount({
    provider: "antigravity",
    label: email,
    email,
    credential: { accessToken: `tok-${email}`, refreshToken: `rt-${email}`, expiresAt: Date.now() + 3600_000 },
    meta: { projectId: `proj-${email}` },
    priority,
  });
}

function ctxFor(body: ResponsesRequest, sessionKey = "thread-xyz"): { ctx: ProviderContext; outcomes: RequestOutcome[] } {
  const outcomes: RequestOutcome[] = [];
  const ctx: ProviderContext = {
    body,
    model: body.model.replace(/^google-antigravity\//, ""),
    requestedModel: body.model,
    effort: body.reasoning?.effort,
    headers: new Headers(),
    sessionKey,
    signal: new AbortController().signal,
    startedAt: Date.now(),
    finish: (o) => outcomes.push(o),
  };
  return { ctx, outcomes };
}

function parseEvents(text: string): any[] {
  return text
    .split("\n\n")
    .map((b) => b.split("\n").find((l) => l.startsWith("data: ")))
    .filter(Boolean)
    .map((l) => JSON.parse(l!.slice(6)));
}

beforeEach(() => {
  useMemoryDb();
  calls = [];
  process.env.GOOGLE_ANTIGRAVITY_CLIENT_SECRET = "test-secret";
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

const tools = [{ type: "function", name: "shell", parameters: { type: "object", properties: { cmd: { type: "string" } } } }];

test("streams a tool call, then replays its thought signature on the next turn", async () => {
  addAccount("a@x.com");
  mockFetch(() =>
    sseBody([
      { response: { candidates: [{ content: { role: "model", parts: [{ text: "plan", thought: true, thoughtSignature: SIG }] } }] } },
      {
        response: {
          candidates: [{ content: { role: "model", parts: [{ functionCall: { name: "shell", args: { cmd: "ls" } } }] }, finishReason: "STOP" }],
          usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 3, thoughtsTokenCount: 2 },
        },
      },
    ]),
  );
  const turn1: ResponsesRequest = {
    model: "google-antigravity/gemini-3.8-flash",
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "list files" }] }],
    tools,
    reasoning: { effort: "low" },
  };
  const { ctx, outcomes } = ctxFor(turn1);
  const res = await antigravityProvider.handle(ctx);
  expect(res.status).toBe(200);
  const events = parseEvents(await res.text());
  const types = events.map((e) => e.type);
  expect(types[0]).toBe("response.created");
  expect(types).toContain("response.reasoning_summary_text.delta");
  expect(types.at(-1)).toBe("response.completed");
  const fcDone = events.find((e) => e.type === "response.output_item.done" && e.item.type === "function_call");
  expect(fcDone.item.name).toBe("shell");
  expect(fcDone.item.arguments).toBe('{"cmd":"ls"}');
  expect(fcDone.item.extra_content.google.thought_signature).toBe(SIG);
  const completed = events.at(-1);
  expect(completed.response.usage).toMatchObject({ input_tokens: 10, output_tokens: 5, output_tokens_details: { reasoning_tokens: 2 } });

  // Upstream request shape.
  const up = calls[0]!;
  expect(up.url).toBe("https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse");
  expect(up.auth).toBe("Bearer tok-a@x.com");
  expect(up.ua).toStartWith("antigravity/ide/");
  expect(up.body.model).toBe("gemini-3.8-flash-low");
  expect(up.body.project).toBe("proj-a@x.com");
  expect(up.body.requestType).toBe("agent");
  expect(up.body.request.sessionId).toMatch(/^-\d+$/);

  expect(outcomes).toHaveLength(1);
  expect(outcomes[0]).toMatchObject({ status: 200, servedModel: "gemini-3.8-flash-low", usage: { inputTokens: 10, outputTokens: 5 } });
  expect(outcomes[0]!.firstTokenMs).toBeGreaterThanOrEqual(0);

  // Turn 2: Codex does not echo extra_content; the proxy must re-attach the signature.
  calls = [];
  mockFetch(() =>
    sseBody([{ response: { candidates: [{ content: { parts: [{ text: "done" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 1 } } }]),
  );
  const turn2: ResponsesRequest = {
    ...turn1,
    input: [
      ...(turn1.input as any[]),
      { type: "function_call", call_id: fcDone.item.call_id, name: "shell", arguments: fcDone.item.arguments },
      { type: "function_call_output", call_id: fcDone.item.call_id, output: "a.txt" },
    ],
  };
  const second = ctxFor(turn2);
  const res2 = await antigravityProvider.handle(second.ctx);
  const ev2 = parseEvents(await res2.text());
  expect(ev2.at(-1).type).toBe("response.completed");
  const contents = calls[0]!.body.request.contents;
  expect(contents[1].role).toBe("model");
  expect(contents[1].parts[0].thoughtSignature).toBe(SIG);
  expect(contents[2].parts[0].functionResponse.response.result).toBe("a.txt");
  expect(calls[0]!.body.request.sessionId).toBe(up.body.request.sessionId);

  // Same call with a different call_id (e.g. rewritten history) still hits the session cache.
  const third = ctxFor({ ...turn2, input: (turn2.input as any[]).map((i) => (i.call_id ? { ...i, call_id: "call_other" } : i)) });
  calls = [];
  await (await antigravityProvider.handle(third.ctx)).text();
  expect(calls[0]!.body.request.contents[1].parts[0].thoughtSignature).toBe(SIG);
});

test("quota-exhausted 429 cools the account down and rotates to another", async () => {
  const a = addAccount("a@x.com", 10);
  const b = addAccount("b@x.com", 0);
  mockFetch((c) => {
    if (c.url.includes("retrieveUserQuotaSummary") || c.url.includes("fetchAvailableModels")) return new Response("{}", { status: 500 });
    if (c.auth === "Bearer tok-a@x.com") {
      return Response.json(
        { error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "You have exhausted your capacity on this model. Your quota will reset after 2h." } },
        { status: 429 },
      );
    }
    return sseBody([{ response: { candidates: [{ content: { parts: [{ text: "hi" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 } } }]);
  });
  const { ctx, outcomes } = ctxFor({ model: "google-antigravity/gemini-3.1-pro", input: "hello" });
  const res = await antigravityProvider.handle(ctx);
  expect(res.status).toBe(200);
  await res.text();
  const gen = calls.filter((c) => c.url.includes("streamGenerateContent"));
  expect(gen.map((c) => c.auth)).toEqual(["Bearer tok-a@x.com", "Bearer tok-b@x.com"]);
  expect(isCooling(a.id, "gem")).toBe(true);
  expect(isCooling(a.id, "cla")).toBe(false);
  expect(isCooling(b.id, "gem")).toBe(false);
  expect(outcomes[0]).toMatchObject({ accountId: b.id, status: 200, servedModel: "gemini-pro-agent" });
});

test("transient 503 is retried on the same account", async () => {
  addAccount("a@x.com");
  let n = 0;
  mockFetch(() => {
    if (n++ === 0) return new Response(JSON.stringify({ error: { message: "overloaded" } }), { status: 503 });
    return sseBody([{ response: { candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }] } }]);
  });
  const { ctx } = ctxFor({ model: "google-antigravity/claude-sonnet-4-6", input: "hello" });
  const res = await antigravityProvider.handle(ctx);
  expect(res.status).toBe(200);
  expect(parseEvents(await res.text()).at(-1).type).toBe("response.completed");
  expect(n).toBe(2);
});

test("401 forces a token refresh and resends once", async () => {
  const a = addAccount("a@x.com");
  mockFetch((c) => {
    if (c.url.startsWith("https://oauth2.googleapis.com/token")) return Response.json({ access_token: "fresh-token", expires_in: 3600 });
    if (c.auth === "Bearer tok-a@x.com") return new Response("{}", { status: 401 });
    return sseBody([{ response: { candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }] } }]);
  });
  const { ctx } = ctxFor({ model: "google-antigravity/gemini-3.8-flash", input: "hello" });
  const res = await antigravityProvider.handle(ctx);
  expect(res.status).toBe(200);
  await res.text();
  const cred = getAccount(a.id)!.credential;
  expect(cred.accessToken).toBe("fresh-token");
  expect(cred.refreshToken).toBe("rt-a@x.com"); // Google refresh tokens do not rotate
});

test("400 schema error is repaired once with an open schema", async () => {
  addAccount("a@x.com");
  let n = 0;
  mockFetch((c) => {
    if (n++ === 0) return Response.json({ error: { message: "Invalid JSON payload: function_declarations[0].parameters bad" } }, { status: 400 });
    expect(c.body.request.tools[0].functionDeclarations[0].parameters).toEqual({ type: "object", properties: {} });
    return sseBody([{ response: { candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }] } }]);
  });
  const { ctx } = ctxFor({ model: "google-antigravity/gemini-3.8-flash", input: "hello", tools });
  const res = await antigravityProvider.handle(ctx);
  expect(res.status).toBe(200);
  await res.text();
  expect(n).toBe(2);
});

test("models: static picker list with prefixed slugs", async () => {
  const models = await antigravityProvider.models();
  expect(models.map((m) => m.slug)).toEqual([
    "google-antigravity/gemini-3.8-flash",
    "google-antigravity/gemini-3.7-flash",
    "google-antigravity/gemini-3.1-pro",
    "google-antigravity/claude-sonnet-4-6",
    "google-antigravity/claude-opus-4-6-thinking",
    "google-antigravity/gpt-oss-120b-medium",
  ]);
  const pro = models.find((m) => m.slug.endsWith("gemini-3.1-pro"))!;
  expect(pro).toMatchObject({ displayName: "agy/gemini-3.1-pro", contextWindow: 1048576, reasoningLevels: ["low", "high"], defaultReasoning: "high", inputModalities: ["text", "image"] });
});
