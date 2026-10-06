import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { useMemoryDb } from "../src/store/db.ts";
import { getAccount, isCooling, upsertAccount } from "../src/store/accounts.ts";
import { _setSleepForTests, opencodeGoProvider, opencodeZenProvider } from "../src/providers/opencode/index.ts";
import type { ProviderContext, RequestOutcome, ResponsesRequest } from "../src/types.ts";

const realFetch = globalThis.fetch;
const sleeps: number[] = [];

beforeEach(() => {
  useMemoryDb();
  sleeps.length = 0;
  _setSleepForTests(async (ms) => {
    sleeps.push(ms);
  });
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

interface Call {
  url: string;
  headers: Record<string, string>;
  body: any;
}

function mockFetch(handler: (call: Call, n: number) => Response): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    const call = { url: String(input), headers, body: init?.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(call);
    return handler(call, calls.length - 1);
  }) as typeof fetch;
  return calls;
}

function chatSse(text: string): Response {
  const lines = [
    { choices: [{ index: 0, delta: { content: text } }] },
    { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
    { choices: [], usage: { prompt_tokens: 7, completion_tokens: 3 } },
  ].map((c) => `data: ${JSON.stringify(c)}\n\n`);
  return new Response(lines.join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
}

function makeCtx(model: string, body: Partial<ResponsesRequest> = {}, sessionKey?: string) {
  const outcomes: RequestOutcome[] = [];
  const ctx: ProviderContext = {
    body: { model, input: "hello", stream: true, ...body } as ResponsesRequest,
    model: model.split("/").slice(1).join("/"),
    requestedModel: model,
    effort: undefined,
    headers: new Headers(),
    sessionKey,
    signal: new AbortController().signal,
    startedAt: Date.now(),
    finish: (o) => outcomes.push(o),
  };
  return { ctx, outcomes };
}

describe("opencode provider handle()", () => {
  test("Go chat: session header, bearer auth, translated SSE, usage, finish once", async () => {
    const acc = upsertAccount({ provider: "opencode-go", label: "k1", credential: { apiKey: "sk-go-1" } });
    const calls = mockFetch(() => chatSse("Hi there"));
    const { ctx, outcomes } = makeCtx("opencode-go/glm-5.1", {}, "thread-1");
    const res = await opencodeGoProvider.handle(ctx);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("response.output_text.delta");
    expect(text).toContain("response.completed");
    expect(calls[0]!.url).toBe("https://opencode.ai/zen/go/v1/chat/completions");
    expect(calls[0]!.headers.authorization).toBe("Bearer sk-go-1");
    expect(calls[0]!.headers["x-opencode-session"]).toMatch(/^ch_[0-9a-f]{32}$/);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({ accountId: acc.id, status: 200, usage: { inputTokens: 7, outputTokens: 3 } });

    // stable per session
    const second = makeCtx("opencode-go/glm-5.1", {}, "thread-1");
    await (await opencodeGoProvider.handle(second.ctx)).text();
    expect(calls[1]!.headers["x-opencode-session"]).toBe(calls[0]!.headers["x-opencode-session"]);
  });

  test("429 rotates to another key and cools the first one down", async () => {
    const a = upsertAccount({ provider: "opencode-zen", label: "a", credential: { apiKey: "sk-a" }, priority: 1 });
    const b = upsertAccount({ provider: "opencode-zen", label: "b", credential: { apiKey: "sk-b" } });
    const calls = mockFetch((call) =>
      call.headers.authorization === "Bearer sk-a"
        ? new Response(JSON.stringify({ error: { message: "Rate limit exceeded" } }), { status: 429 })
        : chatSse("ok"),
    );
    const { ctx, outcomes } = makeCtx("opencode-zen/kimi-k3");
    const res = await opencodeZenProvider.handle(ctx);
    expect(res.status).toBe(200);
    await res.text();
    expect(calls.map((c) => c.headers.authorization)).toEqual(["Bearer sk-a", "Bearer sk-b"]);
    expect(calls[0]!.headers["x-opencode-session"]).toBeUndefined();
    expect(isCooling(a.id, "*")).toBe(true);
    expect(isCooling(b.id, "*")).toBe(false);
    expect(sleeps).toEqual([]); // rotation, no same-key wait
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]!.accountId).toBe(b.id);
  });

  test("single key: 429 retried on the same key honouring Retry-After, then succeeds", async () => {
    upsertAccount({ provider: "opencode-go", label: "only", credential: { apiKey: "sk-only" } });
    const calls = mockFetch((_c, n) =>
      n < 2 ? new Response("{}", { status: 429, headers: { "retry-after": "3" } }) : chatSse("ok"),
    );
    const { ctx, outcomes } = makeCtx("opencode-go/glm-5.1");
    const res = await opencodeGoProvider.handle(ctx);
    await res.text();
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(3);
    expect(sleeps).toEqual([3000, 3000]);
    expect(outcomes).toHaveLength(1);
  });

  test("Zen single key: 429 without Retry-After waits 10s steps then fails with 429 + retry-after", async () => {
    const acc = upsertAccount({ provider: "opencode-zen", label: "only", credential: { apiKey: "sk-z" } });
    mockFetch(() => new Response(JSON.stringify({ error: { message: "Rate limit exceeded" } }), { status: 429 }));
    const { ctx, outcomes } = makeCtx("opencode-zen/kimi-k3");
    const res = await opencodeZenProvider.handle(ctx);
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("15");
    expect(sleeps).toEqual([10_000, 10_000]);
    expect(isCooling(acc.id, "*")).toBe(true);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]!.status).toBe(429);
  });

  test("402 insufficient funds rotates; 401 marks the key", async () => {
    const a = upsertAccount({ provider: "opencode-zen", label: "a", credential: { apiKey: "sk-a" }, priority: 2 });
    const b = upsertAccount({ provider: "opencode-zen", label: "b", credential: { apiKey: "sk-b" }, priority: 1 });
    upsertAccount({ provider: "opencode-zen", label: "c", credential: { apiKey: "sk-c" } });
    mockFetch((call) => {
      if (call.headers.authorization === "Bearer sk-a") return new Response('{"error":{"message":"Insufficient account funds"}}', { status: 402 });
      if (call.headers.authorization === "Bearer sk-b") return new Response('{"type":"error","error":{"type":"AuthError","message":"Invalid API key."}}', { status: 401 });
      return chatSse("ok");
    });
    const { ctx, outcomes } = makeCtx("opencode-zen/glm-5.1");
    const res = await opencodeZenProvider.handle(ctx);
    await res.text();
    expect(res.status).toBe(200);
    expect(isCooling(a.id, "*")).toBe(true);
    expect(getAccount(b.id)!.status).toBe("error");
    expect(outcomes).toHaveLength(1);
  });

  test("Anthropic wire for Go minimax: x-api-key + anthropic-version", async () => {
    upsertAccount({ provider: "opencode-go", label: "k", credential: { apiKey: "sk-go" } });
    const calls = mockFetch(() => {
      const ev = [
        { type: "message_start", message: { usage: { input_tokens: 4, output_tokens: 0 } } },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "yo" } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } },
        { type: "message_stop" },
      ];
      return new Response(ev.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""));
    });
    const { ctx, outcomes } = makeCtx("opencode-go/minimax-m2.7");
    const text = await (await opencodeGoProvider.handle(ctx)).text();
    expect(calls[0]!.url).toBe("https://opencode.ai/zen/go/v1/messages");
    expect(calls[0]!.headers["x-api-key"]).toBe("sk-go");
    expect(calls[0]!.headers["anthropic-version"]).toBe("2023-06-01");
    expect(calls[0]!.headers.authorization).toBeUndefined();
    expect(text).toContain('"delta":"yo"');
    expect(outcomes[0]!.usage).toMatchObject({ inputTokens: 4, outputTokens: 2 });
  });

  test("Responses passthrough: stateless body, usage side-scan, synthesized failure on truncation", async () => {
    upsertAccount({ provider: "opencode-go", label: "k", credential: { apiKey: "sk-go" } });
    const completed = {
      type: "response.completed",
      response: { id: "resp_x", status: "completed", output: [], usage: { input_tokens: 11, output_tokens: 2, input_tokens_details: { cached_tokens: 1 } } },
    };
    const calls = mockFetch((_c, n) =>
      n === 0
        ? new Response(`event: response.created\ndata: ${JSON.stringify({ type: "response.created", response: { id: "resp_x" } })}\n\nevent: response.completed\ndata: ${JSON.stringify(completed)}\n\n`)
        : new Response(`event: response.created\ndata: ${JSON.stringify({ type: "response.created", response: { id: "resp_y" } })}\n\n`),
    );
    const one = makeCtx("opencode-go/gpt-5.6-luna", { previous_response_id: "resp_prev" });
    const t1 = await (await opencodeGoProvider.handle(one.ctx)).text();
    expect(calls[0]!.url).toBe("https://opencode.ai/zen/go/v1/responses");
    expect(calls[0]!.body.previous_response_id).toBeUndefined();
    expect(calls[0]!.body.store).toBe(false);
    expect(calls[0]!.body.model).toBe("gpt-5.6-luna");
    expect(t1).toContain("response.completed");
    expect(one.outcomes[0]).toMatchObject({ status: 200, usage: { inputTokens: 11, outputTokens: 2, cachedInputTokens: 1 } });

    const two = makeCtx("opencode-go/gpt-5.6-luna");
    const t2 = await (await opencodeGoProvider.handle(two.ctx)).text();
    expect(t2).toContain("response.failed");
    expect(two.outcomes[0]!.status).toBe(502);
  });

  test("non-retryable 403 free-tier refusal is surfaced with a hint", async () => {
    upsertAccount({ provider: "opencode-zen", label: "k", credential: { apiKey: "sk-z" } });
    mockFetch(() => new Response('{"type":"error","error":{"type":"FreeTierError","message":"OpenCode\'s free tier can only be used from within OpenCode"}}', { status: 403 }));
    const { ctx, outcomes } = makeCtx("opencode-zen/big-pickle");
    const res = await opencodeZenProvider.handle(ctx);
    expect(res.status).toBe(403);
    expect(((await res.json()) as any).error.message).toContain("free-tier");
    expect(outcomes).toHaveLength(1);
  });

  test("no accounts -> 503", async () => {
    const { ctx, outcomes } = makeCtx("opencode-go/glm-5.1");
    const res = await opencodeGoProvider.handle(ctx);
    expect(res.status).toBe(503);
    expect(outcomes).toHaveLength(1);
  });
});

describe("opencode provider accounts & models", () => {
  test("addApiKey validates, stores, rejects duplicates and invalid keys", async () => {
    mockFetch((call) => {
      if (call.url.endsWith("/models")) return Response.json({ data: [{ id: "glm-5.1" }] });
      if (call.headers.authorization === "Bearer sk-bad") return new Response('{"type":"error","error":{"type":"AuthError","message":"Invalid API key."}}', { status: 401 });
      return new Response('{"error":{"message":"Model is unavailable."}}', { status: 400 });
    });
    const acc = await opencodeGoProvider.addApiKey!("sk-good-1234", "mine");
    expect(acc.credential).toEqual({ apiKey: "sk-good-1234" });
    expect(acc.label).toBe("mine");
    await expect(opencodeGoProvider.addApiKey!("sk-good-1234")).rejects.toThrow(/already/);
    await expect(opencodeGoProvider.addApiKey!("sk-bad")).rejects.toThrow(/rejected/);
  });

  test("models(): discovery + metadata, non-chat excluded, free-tier hidden, cached", async () => {
    upsertAccount({ provider: "opencode-zen", label: "k", credential: { apiKey: "sk-z" } });
    const calls = mockFetch(() =>
      Response.json({ data: [{ id: "kimi-k3" }, { id: "test" }, { id: "big-pickle" }, { id: "deepseek-v4-pro" }, { id: "gpt-5.5" }] }),
    );
    const models = await opencodeZenProvider.models();
    expect(models.map((m) => m.slug)).toEqual([
      "opencode-zen/kimi-k3",
      "opencode-zen/big-pickle",
      "opencode-zen/deepseek-v4-pro",
      "opencode-zen/gpt-5.5",
    ]);
    const kimi = models[0]!;
    expect(kimi).toMatchObject({ displayName: "opencode-zen/kimi-k3", contextWindow: 262144, inputModalities: ["text", "image"], defaultReasoning: "max" });
    expect(models[1]!.hidden).toBe(true);
    expect(models[2]!.inputModalities).toEqual(["text"]);
    await opencodeZenProvider.models();
    expect(calls).toHaveLength(1);
  });

  test("models(): static fallback when discovery fails", async () => {
    mockFetch(() => new Response("down", { status: 503 }));
    const models = await opencodeGoProvider.models();
    expect(models.length).toBeGreaterThan(10);
    expect(models.some((m) => m.slug === "opencode-go/glm-5.1")).toBe(true);
  });
});
