import { afterEach, beforeEach, expect, test } from "bun:test";
import { useMemoryDb } from "../src/store/db.ts";
import { getAccount, getQuota, isCooling, upsertAccount } from "../src/store/accounts.ts";
import { chatgptImages, chatgptProvider, streamThrough } from "../src/providers/chatgpt/index.ts";
import { parseQuotaHeaders, parseWhamUsage, usageScore } from "../src/providers/chatgpt/quota.ts";
import { refreshAccount, resetTokenState } from "../src/providers/chatgpt/tokens.ts";
import { buildAuthUrl, tokenIdentity } from "../src/providers/chatgpt/oauth.ts";
import { chatgptWireModel } from "../src/providers/chatgpt/catalog.ts";
import { rewriteBody, SseScanner, upstreamBody } from "../src/providers/chatgpt/upstream.ts";
import type { Account, ProviderContext, RequestOutcome, ResponsesRequest } from "../src/types.ts";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function jwt(payload: Record<string, unknown>): string {
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${enc({ alg: "none" })}.${enc(payload)}.sig`;
}

function token(accountId: string, email: string, expSecFromNow = 3600, tag = "a"): string {
  return jwt({
    exp: Math.floor(Date.now() / 1000) + expSecFromNow,
    email,
    tag,
    "https://api.openai.com/auth": { chatgpt_account_id: accountId, chatgpt_plan_type: "plus" },
  });
}

function addAccount(name: string, opts: { priority?: number; expSec?: number } = {}): Account {
  const access = token(`cg-${name}`, `${name}@example.com`, opts.expSec ?? 3600);
  return upsertAccount(
    {
      provider: "chatgpt",
      label: `${name}@example.com`,
      email: `${name}@example.com`,
      credential: {
        accessToken: access,
        refreshToken: `rt-${name}`,
        expiresAt: Date.now() + (opts.expSec ?? 3600) * 1000,
        chatgptAccountId: `cg-${name}`,
      },
      meta: { plan: "plus" },
      priority: opts.priority ?? 0,
    },
    { email: `${name}@example.com` },
  );
}

interface Call {
  url: string;
  method: string;
  headers: Headers;
  body: string;
}

let calls: Call[] = [];
const realFetch = globalThis.fetch;

function mockFetch(handler: (c: Call, n: number) => Response | Promise<Response>) {
  calls = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const c: Call = {
      url,
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? init.body : "",
    };
    calls.push(c);
    return handler(c, calls.length);
  }) as typeof fetch;
}

const upstreamCalls = () => calls.filter((c) => c.url.startsWith("https://chatgpt.com/"));
const tokenCalls = () => calls.filter((c) => c.url === "https://auth.openai.com/oauth/token");

function sse(events: Array<Record<string, unknown>>, headers: Record<string, string> = {}, status = 200): Response {
  const text = events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
  return new Response(text, { status, headers: { "content-type": "text/event-stream", ...headers } });
}

const completed = (usage = { input_tokens: 120, output_tokens: 7, total_tokens: 127, input_tokens_details: { cached_tokens: 100 }, output_tokens_details: { reasoning_tokens: 3 } }) => [
  { type: "response.created", response: { id: "resp_1", model: "gpt-6-luna", status: "in_progress" } },
  { type: "response.output_text.delta", delta: "OK" },
  { type: "response.completed", response: { id: "resp_1", model: "gpt-6-luna", status: "completed", usage } },
];

function makeCtx(body: Partial<ResponsesRequest>, headers: Record<string, string> = {}, sessionKey?: string) {
  const finished: RequestOutcome[] = [];
  const requestedModel = String(body.model ?? "gpt-6-luna");
  const ctx: ProviderContext = {
    body: { model: requestedModel, ...body } as ResponsesRequest,
    model: requestedModel.startsWith("openai/") ? requestedModel.slice(7) : requestedModel,
    requestedModel,
    effort: undefined,
    headers: new Headers(headers),
    sessionKey,
    signal: new AbortController().signal,
    startedAt: Date.now(),
    finish: (o) => finished.push(o),
  };
  return { ctx, finished };
}

const minimalBody = {
  model: "gpt-6-luna",
  instructions: "Reply with OK.",
  input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
  stream: true,
  store: false,
};

beforeEach(() => {
  useMemoryDb();
  resetTokenState();
  delete process.env.CH_CHATGPT_NO_REFRESH;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

test("rewrites headers and body for the ChatGPT backend", async () => {
  const acc = addAccount("alice");
  mockFetch(() => sse(completed()));
  const { ctx, finished } = makeCtx(
    {
      ...minimalBody,
      model: "openai/codex-auto-review",
      temperature: 0.2,
      top_p: 0.9,
      metadata: { a: 1 },
      previous_response_id: "resp_old",
      max_output_tokens: 100,
      truncation: "auto",
      prompt_cache_retention: "24h",
      input: [
        { type: "message", role: "system", content: [{ type: "input_text", text: "Be terse." }] },
        { type: "item_reference", id: "msg_1" },
        { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
      ],
    },
    {
      authorization: "Bearer client-token",
      "chatgpt-account-id": "client-account",
      "session-id": "sess-1",
      "x-codex-turn-metadata": "tm",
      "user-agent": "codex_cli_rs/0.200",
      "x-unrelated": "nope",
    },
  );
  const res = await chatgptProvider.handle(ctx);
  await res.text();

  const up = upstreamCalls();
  expect(up.length).toBe(1);
  const c = up[0]!;
  expect(c.url).toBe("https://chatgpt.com/backend-api/codex/responses");
  expect(c.headers.get("authorization")).toBe(`Bearer ${(acc.credential as { accessToken: string }).accessToken}`);
  expect(c.headers.get("chatgpt-account-id")).toBe("cg-alice");
  expect(c.headers.get("session-id")).toBe("sess-1");
  expect(c.headers.get("x-codex-turn-metadata")).toBe("tm");
  expect(c.headers.get("user-agent")).toBe("codex_cli_rs/0.200");
  expect(c.headers.get("originator")).toBe("codex_cli_rs");
  expect(c.headers.get("x-unrelated")).toBeNull();

  const body = JSON.parse(c.body);
  // Legacy auto-review slug is served as Astra upstream.
  expect(body.model).toBe("gpt-6-astra");
  for (const f of ["temperature", "top_p", "metadata", "previous_response_id", "max_output_tokens", "truncation", "prompt_cache_retention"]) {
    expect(body[f]).toBeUndefined();
  }
  expect(body.instructions).toBe("Reply with OK.\n\nBe terse.");
  expect(body.input).toEqual([{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }]);
  expect(body.stream).toBe(true);
  expect(body.store).toBe(false);
  expect(finished.length).toBe(1);
  expect(tokenCalls().length).toBe(0); // valid token: never refreshed
});

test("system messages with images are not folded", () => {
  const body = rewriteBody(
    {
      model: "x",
      input: [{ type: "message", role: "system", content: [{ type: "input_image", image_url: "data:" }] }],
    },
    "gpt-6-luna",
  );
  expect((body.input as unknown[]).length).toBe(1);
  expect(body.instructions).toBeUndefined();
});

test("streams bytes unchanged and extracts usage from response.completed", async () => {
  const acc = addAccount("bob");
  const upstreamText = completed()
    .map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`)
    .join("");
  mockFetch(
    () =>
      new Response(upstreamText, {
        status: 200,
        headers: {
          "content-type": "text/event-stream",
          "openai-model": "gpt-6-luna-2026",
          "content-encoding": "gzip",
          "set-cookie": "x=y",
          "x-request-id": "req_1",
        },
      }),
  );
  const { ctx, finished } = makeCtx(minimalBody);
  const res = await chatgptProvider.handle(ctx);
  expect(res.status).toBe(200);
  expect(res.headers.get("content-encoding")).toBeNull();
  expect(res.headers.get("set-cookie")).toBeNull();
  expect(res.headers.get("x-request-id")).toBe("req_1");
  expect(await res.text()).toBe(upstreamText);
  expect(finished.length).toBe(1);
  const o = finished[0]!;
  expect(o.accountId).toBe(acc.id);
  expect(o.status).toBe(200);
  expect(o.servedModel).toBe("gpt-6-luna-2026");
  expect(o.usage).toEqual({ inputTokens: 120, outputTokens: 7, cachedInputTokens: 100, reasoningOutputTokens: 3 });
  expect(o.firstTokenMs).toBeGreaterThanOrEqual(0);
  expect(o.error).toBeUndefined();
});

test("cancelling a pending stream finishes once with 499 and cancels upstream after read settles", async () => {
  const acc = addAccount("cancel-pending");
  const { ctx, finished } = makeCtx(minimalBody);
  let release!: () => void;
  let pulls = 0;
  let upstreamCancels = 0;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const upstream = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls++;
      return pending.then(() => controller.enqueue(new Uint8Array([0x78])));
    },
    cancel() {
      upstreamCancels++;
    },
  });
  const response = streamThrough(ctx, new Response(upstream, { status: 200 }), acc, "gpt-6-luna");
  const reader = response.body!.getReader();
  const read = reader.read();
  await Bun.sleep(0);
  expect(pulls).toBe(1);

  const cancel = reader.cancel("client left");
  release();
  await Promise.all([read, cancel]);
  await Bun.sleep(0);

  expect(finished).toHaveLength(1);
  expect(finished[0]).toMatchObject({ status: 499, error: "client cancelled" });
  expect(upstreamCancels).toBe(1);
});

test("streamThrough: disconnect after response.completed is not an error", async () => {
  const acc = addAccount("ivy");
  const { ctx, finished } = makeCtx(minimalBody);
  const done = new TextEncoder().encode(`data: ${JSON.stringify(completed()[2])}

`);
  let sent = false;
  const upstream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (!sent) {
        sent = true;
        controller.enqueue(done);
      }
      return new Promise(() => {}); // upstream keeps the socket open
    },
  });
  const reader = streamThrough(ctx, new Response(upstream, { status: 200 }), acc, "gpt-6-luna").body!.getReader();
  await reader.read();
  await reader.cancel("codex has what it needs");
  await Bun.sleep(0);
  expect(finished).toHaveLength(1);
  expect(finished[0]!.status).toBe(200);
  expect(finished[0]!.error).toBeUndefined();
});

test("SSE scanner handles frames split across chunks", () => {
  const s = new SseScanner();
  const text = `data: ${JSON.stringify(completed()[2])}\n\n`;
  const bytes = new TextEncoder().encode(text);
  for (let i = 0; i < bytes.length; i += 7) s.push(bytes.slice(i, i + 7));
  s.end();
  expect(s.completed).toBe(true);
  expect(s.usage?.inputTokens).toBe(120);
});

test("parses x-codex quota headers and stores them", async () => {
  const acc = addAccount("carol");
  const now = Math.floor(Date.now() / 1000);
  mockFetch(() =>
    sse(completed(), {
      "x-codex-primary-used-percent": "42.5",
      "x-codex-primary-window-minutes": "300",
      "x-codex-primary-reset-at": String(now + 3600),
      "x-codex-secondary-used-percent": "12",
      "x-codex-secondary-window-minutes": "10080",
      "x-codex-secondary-reset-at": String(now + 86400 * 3),
    }),
  );
  const { ctx } = makeCtx(minimalBody);
  await (await chatgptProvider.handle(ctx)).text();
  const q = getQuota(acc.id)!;
  expect(q.shortPercent).toBe(42.5);
  expect(q.weeklyPercent).toBe(12);
  expect(q.shortResetAt).toBe((now + 3600) * 1000);
  expect(q.weeklyResetAt).toBe((now + 86400 * 3) * 1000);
  expect(usageScore(acc.id)).toBe(42.5);

  // Weekly-only (no short window declared): primary is the weekly window.
  const weekly = parseQuotaHeaders(new Headers({ "x-codex-primary-used-percent": "70", "x-codex-primary-reset-at": String(now + 100) }));
  expect(weekly).toEqual({ weeklyPercent: 70, weeklyResetAt: (now + 100) * 1000 });
  expect(parseQuotaHeaders(new Headers())).toBeNull();
});

test("WHAM usage payload parsing", () => {
  const q = parseWhamUsage({
    email: "X@Example.com",
    plan_type: "pro",
    rate_limit: {
      primary_window: { used_percent: 5, reset_at: 2_000_000_000, limit_window_seconds: 18000 },
      secondary_window: { used_percent: 55, reset_at: 2_000_500_000, limit_window_seconds: 604800 },
    },
  });
  expect(q).toEqual({
    plan: "pro",
    email: "x@example.com",
    shortPercent: 5,
    shortResetAt: 2_000_000_000_000,
    weeklyPercent: 55,
    weeklyResetAt: 2_000_500_000_000,
  });
});

test("429 cools the account down and retries once on another account", async () => {
  const a = addAccount("first", { priority: 1 });
  const b = addAccount("second", { priority: 0 });
  mockFetch((c) => {
    if (c.headers.get("chatgpt-account-id") === "cg-first") {
      return Response.json({ error: { type: "usage_limit_reached", message: "limit" } }, { status: 429, headers: { "retry-after": "120" } });
    }
    return sse(completed());
  });
  const { ctx, finished } = makeCtx(minimalBody);
  const res = await chatgptProvider.handle(ctx);
  expect(res.status).toBe(200);
  await res.text();
  const up = upstreamCalls();
  expect(up.map((c) => c.headers.get("chatgpt-account-id"))).toEqual(["cg-first", "cg-second"]);
  expect(isCooling(a.id, "*")).toBe(true);
  expect(isCooling(b.id, "*")).toBe(false);
  expect(finished[0]!.accountId).toBe(b.id);

  // Next request skips the cooling account directly.
  mockFetch(() => sse(completed()));
  const second = makeCtx(minimalBody);
  await (await chatgptProvider.handle(second.ctx)).text();
  expect(upstreamCalls().map((c) => c.headers.get("chatgpt-account-id"))).toEqual(["cg-second"]);
});

test("high usage account is avoided while another has headroom", async () => {
  addAccount("busy", { priority: 1 });
  addAccount("idle", { priority: 1 });
  const now = Math.floor(Date.now() / 1000);
  mockFetch((c) => {
    const busy = c.headers.get("chatgpt-account-id") === "cg-busy";
    return sse(completed(), {
      "x-codex-primary-used-percent": busy ? "95" : "10",
      "x-codex-primary-window-minutes": "300",
      "x-codex-primary-reset-at": String(now + 3600),
    });
  });
  // Warm both quota snapshots.
  for (let i = 0; i < 2; i++) await (await chatgptProvider.handle(makeCtx(minimalBody).ctx)).text();
  mockFetch(() => sse(completed()));
  for (let i = 0; i < 3; i++) await (await chatgptProvider.handle(makeCtx(minimalBody).ctx)).text();
  expect(upstreamCalls().every((c) => c.headers.get("chatgpt-account-id") === "cg-idle")).toBe(true);
});

test("429 on every account returns the upstream error; then a cooldown message", async () => {
  addAccount("x1");
  addAccount("x2");
  mockFetch(() => Response.json({ error: { type: "usage_limit_reached", resets_in_seconds: 600 } }, { status: 429 }));
  const { ctx, finished } = makeCtx(minimalBody);
  const res = await chatgptProvider.handle(ctx);
  expect(res.status).toBe(429);
  expect(upstreamCalls().length).toBe(2);
  expect(finished[0]!.status).toBe(429);

  const again = makeCtx(minimalBody);
  const res2 = await chatgptProvider.handle(again.ctx);
  expect(res2.status).toBe(429);
  const j = (await res2.json()) as { error: { message: string; resets_in_seconds: number } };
  expect(j.error.message).toContain("cooling down");
  expect(j.error.resets_in_seconds).toBeGreaterThan(500);
  expect(Number(res2.headers.get("retry-after"))).toBeGreaterThan(500);
  expect(again.finished.length).toBe(1);
});

test("401 refreshes the token once and replays the request", async () => {
  const acc = addAccount("dave");
  const oldToken = (acc.credential as { accessToken: string }).accessToken;
  const newToken = token("cg-dave", "dave@example.com", 3600, "new");
  mockFetch((c) => {
    if (c.url === "https://auth.openai.com/oauth/token") {
      return Response.json({ access_token: newToken, refresh_token: "rt-dave-2", expires_in: 3600 });
    }
    if (c.headers.get("authorization") === `Bearer ${oldToken}`) return new Response("unauthorized", { status: 401 });
    return sse(completed());
  });
  const { ctx, finished } = makeCtx(minimalBody);
  const res = await chatgptProvider.handle(ctx);
  expect(res.status).toBe(200);
  await res.text();
  expect(tokenCalls().length).toBe(1);
  const form = new URLSearchParams(tokenCalls()[0]!.body);
  expect(form.get("grant_type")).toBe("refresh_token");
  expect(form.get("refresh_token")).toBe("rt-dave");
  expect(form.get("client_id")).toBe("app_EMoamEEZ73f0CkXaXp7hrann");
  const up = upstreamCalls();
  expect(up.length).toBe(2);
  expect(up[1]!.headers.get("authorization")).toBe(`Bearer ${newToken}`);
  const stored = getAccount(acc.id)!.credential as { accessToken: string; refreshToken: string };
  expect(stored.accessToken).toBe(newToken);
  expect(stored.refreshToken).toBe("rt-dave-2");
  expect(finished[0]!.status).toBe(200);
});

test("401 after refresh marks the account needs_reauth", async () => {
  const acc = addAccount("erin");
  mockFetch((c) => {
    if (c.url === "https://auth.openai.com/oauth/token") {
      return Response.json({ access_token: token("cg-erin", "erin@example.com", 3600, "n"), expires_in: 3600 });
    }
    return new Response("unauthorized", { status: 401 });
  });
  const { ctx, finished } = makeCtx(minimalBody);
  const res = await chatgptProvider.handle(ctx);
  expect(res.status).toBe(401);
  expect(getAccount(acc.id)!.status).toBe("needs_reauth");
  expect(finished.length).toBe(1);
});

test("revoked refresh token marks needs_reauth and falls over to another account", async () => {
  const a = addAccount("revoked", { priority: 1, expSec: -10 }); // expired -> proactive refresh
  addAccount("fine", { priority: 0 });
  mockFetch((c) => {
    if (c.url === "https://auth.openai.com/oauth/token") {
      return Response.json({ error: "invalid_grant", error_description: "revoked" }, { status: 400 });
    }
    return sse(completed());
  });
  const { ctx, finished } = makeCtx(minimalBody);
  const res = await chatgptProvider.handle(ctx);
  expect(res.status).toBe(200);
  await res.text();
  expect(getAccount(a.id)!.status).toBe("needs_reauth");
  expect(upstreamCalls().map((c) => c.headers.get("chatgpt-account-id"))).toEqual(["cg-fine"]);
  expect(finished[0]!.accountId).not.toBe(a.id);
});

test("concurrent refreshes of one account are deduped", async () => {
  const acc = addAccount("frank", { expSec: -10 });
  let resolve!: (r: Response) => void;
  mockFetch(() => new Promise<Response>((r) => (resolve = r)));
  const stale = (acc.credential as { accessToken: string }).accessToken;
  const p1 = refreshAccount(acc.id, stale);
  const p2 = refreshAccount(acc.id, stale);
  await Bun.sleep(5);
  resolve(Response.json({ access_token: token("cg-frank", "frank@example.com", 3600, "z"), refresh_token: "rt2", expires_in: 3600 }));
  const [c1, c2] = await Promise.all([p1, p2]);
  expect(tokenCalls().length).toBe(1);
  expect(c1.accessToken).toBe(c2.accessToken);
});

test("in-stream usage_limit_reached cools the account down", async () => {
  const acc = addAccount("gina");
  mockFetch(() =>
    sse([
      { type: "response.created", response: { id: "r", model: "gpt-6-luna" } },
      { type: "response.failed", response: { id: "r", status: "failed", error: { code: "usage_limit_reached", message: "limit hit" } } },
    ]),
  );
  const { ctx, finished } = makeCtx(minimalBody);
  await (await chatgptProvider.handle(ctx)).text();
  expect(isCooling(acc.id, "*")).toBe(true);
  expect(finished[0]!.error).toContain("usage_limit_reached");
});

test("5xx retries once on another account", async () => {
  addAccount("s1", { priority: 1 });
  addAccount("s2", { priority: 0 });
  mockFetch((c) => (c.headers.get("chatgpt-account-id") === "cg-s1" ? new Response("bad gateway", { status: 502 }) : sse(completed())));
  const { ctx, finished } = makeCtx(minimalBody);
  const res = await chatgptProvider.handle(ctx);
  expect(res.status).toBe(200);
  await res.text();
  expect(upstreamCalls().length).toBe(2);
  expect(finished.length).toBe(1);
});

test("compact forwards JSON to /responses/compact without reasoning", async () => {
  addAccount("hank");
  mockFetch(() => Response.json({ output: [{ type: "compaction", encrypted_content: "abc" }], usage: { input_tokens: 10, output_tokens: 2 } }));
  const { ctx, finished } = makeCtx({ model: "openai/codex-auto-review", input: [], instructions: "x", reasoning: { effort: "high" } });
  const res = await chatgptProvider.compact!(ctx);
  expect(res.status).toBe(200);
  const j = (await res.json()) as { output: unknown[] };
  expect(j.output.length).toBe(1);
  const c = upstreamCalls()[0]!;
  expect(c.url).toBe("https://chatgpt.com/backend-api/codex/responses/compact");
  const body = JSON.parse(c.body);
  expect(body.model).toBe("gpt-6-astra");
  expect(body.reasoning).toBeUndefined();
  expect(finished[0]!.usage?.inputTokens).toBe(10);
});

test("refreshQuota reads WHAM usage", async () => {
  const acc = addAccount("ivy");
  mockFetch(() =>
    Response.json({
      plan_type: "pro",
      rate_limit: { primary_window: { used_percent: 33, reset_at: 2_000_000_000, limit_window_seconds: 604800 } },
    }),
  );
  await chatgptProvider.refreshQuota!(acc);
  expect(calls[0]!.url).toBe("https://chatgpt.com/backend-api/wham/usage");
  expect(calls[0]!.headers.get("chatgpt-account-id")).toBe("cg-ivy");
  expect(getQuota(acc.id)!.weeklyPercent).toBe(33);
  expect(getAccount(acc.id)!.meta.plan).toBe("pro");
});

test("no accounts -> 429 JSON error", async () => {
  mockFetch(() => sse(completed()));
  const { ctx, finished } = makeCtx(minimalBody);
  const res = await chatgptProvider.handle(ctx);
  expect(res.status).toBe(429);
  expect(upstreamCalls().length).toBe(0);
  expect(finished.length).toBe(1);
});

test("auth URL and JWT identity", () => {
  const url = new URL(buildAuthUrl("chal", "st"));
  expect([...url.searchParams.keys()]).toEqual([
    "response_type",
    "client_id",
    "redirect_uri",
    "scope",
    "code_challenge",
    "code_challenge_method",
    "state",
    "codex_cli_simplified_flow",
    "originator",
    "id_token_add_organizations",
  ]);
  expect(url.searchParams.get("originator")).toBe("codex_cli_rs");
  expect(url.searchParams.get("redirect_uri")).toBe("http://localhost:1455/auth/callback");
  expect(tokenIdentity(undefined, token("acc-9", "Z@X.com"))).toEqual({ accountId: "acc-9", email: "z@x.com", plan: "plus" });
});

test("images: forwarded through a pooled account with the raw body", async () => {
  addAccount("pix");
  mockFetch(() => Response.json({ data: [{ b64_json: "QQ==" }], usage: { input_tokens: 5, output_tokens: 50 } }));
  const { ctx, finished } = makeCtx({ model: "gpt-image-2" });
  const body = new TextEncoder().encode(JSON.stringify({ prompt: "cube", model: "gpt-image-2" }));
  const res = await chatgptImages(ctx, "generations", body, "application/json");
  expect(res.status).toBe(200);
  const c = upstreamCalls()[0]!;
  expect(c.url).toBe("https://chatgpt.com/backend-api/codex/images/generations");
  expect(c.headers.get("authorization")).toStartWith("Bearer ");
  expect(c.headers.get("chatgpt-account-id")).toBe("cg-pix");
  expect(finished[0]).toMatchObject({ status: 200, accountId: expect.any(String) });
  expect(finished[0]!.usage?.outputTokens).toBe(50);
});

test("auto-review is retired: slug resolves to Astra and gets no special instructions", () => {
  expect(chatgptWireModel("openai/codex-auto-review")).toBe("gpt-6-astra");
  expect(chatgptWireModel("codex-auto-review")).toBe("gpt-6-astra");
  const src = { model: "x", instructions: "Base.", text: { verbosity: "medium" } };
  const body = upstreamBody(src, chatgptWireModel("codex-auto-review"), new Headers());
  expect(body.model).toBe("gpt-6-astra");
  expect(body.instructions).toBe("Base.");
  expect(body.text).toEqual({ verbosity: "medium" });
});
