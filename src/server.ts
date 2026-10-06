import { providers } from "./providers/index.ts";
import { route, sessionKeyFrom } from "./router.ts";
import { jsonError } from "./lib/sse.ts";
import { imageModelOf, readBody, readBodyBytes } from "./lib/body.ts";
import { chatgptImages } from "./providers/chatgpt/index.ts";
import { log, redact } from "./lib/log.ts";
import { recordUsage } from "./usage.ts";
import {
  collectText,
  compactionError,
  compactionV1Response,
  compactionV2Response,
  isCompactionTrigger,
  rewriteCompactionItems,
  summarizerRequest,
} from "./compaction.ts";
import { handleApi, setApiServerInfo } from "./api.ts";
import { toChatCompletionJson, toChatCompletionStream, toResponsesBody } from "./chatcompletions.ts";
import { reqCacheGet, reqCacheKey, reqCacheTap, reqCacheTtlMs } from "./lib/reqcache.ts";
import { restoreStream, toRoutedRequest } from "./tool-compat.ts";
import type { ProviderContext, ResponsesRequest } from "./types.ts";
import gui from "../gui/index.html";

export const VERSION = "0.1.0";
export const startedAt = Date.now();

function buildContext(req: Request, body: ResponsesRequest): { ctx: ProviderContext; providerId: ReturnType<typeof route>["provider"] } {
  const r = route(body.model);
  const started = Date.now();
  let finished = false;
  const effort = body.reasoning?.effort ?? undefined;
  const ctx: ProviderContext = {
    body,
    model: r.model,
    requestedModel: body.model,
    effort,
    headers: req.headers,
    sessionKey: sessionKeyFrom(req.headers, body),
    signal: req.signal,
    startedAt: started,
    finish(outcome) {
      if (finished) return;
      finished = true;
      try {
        recordUsage({ ...outcome, provider: r.provider, requestedModel: body.model, effort, startedAt: started });
      } catch (err) {
        log.error("usage record failed", String(err));
      }
      const u = outcome.usage;
      log.info(
        `${outcome.status} ${body.model} acct=${outcome.accountId ?? "-"} ${Date.now() - started}ms` +
          (u ? ` in=${u.inputTokens} cached=${u.cachedInputTokens ?? 0} out=${u.outputTokens}` : "") +
          (outcome.error ? ` err=${redact(outcome.error)}` : ""),
      );
    },
  };
  return { ctx, providerId: r.provider };
}

async function handleResponses(req: Request, compact: boolean): Promise<Response> {
  const rawText = await readBody(req);
  let body: ResponsesRequest;
  try {
    body = JSON.parse(rawText) as ResponsesRequest;
  } catch (err) {
    return jsonError(400, `invalid request body: ${err instanceof Error ? err.message : String(err)}`, "invalid_request_error");
  }
  if (!body?.model) return jsonError(400, "missing model", "invalid_request_error");
  if (process.env.CH_DUMP) {
    // Debug: dump inbound request bodies (no headers, so no bearer tokens) for protocol inspection.
    await Bun.write(`${process.env.CH_DUMP}/${Date.now()}-${compact ? "compact" : "responses"}.json`, JSON.stringify(body, null, 2));
  }
  // Replay cache: identical retried bodies skip upstream entirely.
  const ck =
    !compact && reqCacheTtlMs() > 0
      ? reqCacheKey("responses", rawText, req.headers.get("authorization"))
      : null;
  if (ck) {
    const hit = reqCacheGet(ck);
    if (hit) {
      log.info(`reqcache hit responses model=${body.model}`);
      return hit;
    }
  }
  const routed = route(body.model).provider !== "chatgpt";
  body = rewriteCompactionItems(body, routed);
  const { ctx, providerId } = buildContext(req, body);
  const provider = providers[providerId];
  try {
    // Routed models: emulate remote compaction (v1 endpoint and v2 trigger) with a summarizer run.
    if (routed && (compact || isCompactionTrigger(body))) {
      ctx.body = summarizerRequest(body);
      const { text, usage, error } = await collectText(await provider.handle(ctx));
      if (error && !text) return compactionError(redact(error));
      return compact ? compactionV1Response(body, text) : compactionV2Response(body.model, text, usage);
    }
    if (compact) {
      if (!provider.compact) return jsonError(404, `compact not supported for ${providerId}`, "not_found");
      return await provider.compact(ctx);
    }
    if (routed) {
      const { body: routedBody, map } = toRoutedRequest(body);
      ctx.body = routedBody;
      return restoreStream(await provider.handle(ctx), map);
    }
    return reqCacheTap(await provider.handle(ctx), ck);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    ctx.finish({ accountId: null, servedModel: ctx.model, status: 500, error: msg });
    return jsonError(500, redact(msg));
  }
}

/** OpenAI chat.completions surface: convert to a Responses body, run the same
 *  provider pipeline (autocut included), translate the stream back. */
async function handleChatCompletions(req: Request): Promise<Response> {
  const rawText = await readBody(req);
  let raw: Record<string, any>;
  try {
    raw = JSON.parse(rawText) as Record<string, any>;
  } catch (err) {
    return jsonError(400, `invalid request body: ${err instanceof Error ? err.message : String(err)}`, "invalid_request_error");
  }
  if (!raw?.model) return jsonError(400, "missing model", "invalid_request_error");
  const ck = reqCacheTtlMs() > 0 ? reqCacheKey("chat", rawText, req.headers.get("authorization")) : null;
  if (ck) {
    const hit = reqCacheGet(ck);
    if (hit) {
      log.info(`reqcache hit chat model=${raw.model}`);
      return hit;
    }
  }
  const wantStream = raw.stream === true;
  const body = rewriteCompactionItems(toResponsesBody(raw), route(raw.model).provider !== "chatgpt");
  const { ctx, providerId } = buildContext(req, body);
  const provider = providers[providerId];
  try {
    const res = await provider.handle(ctx);
    const isSse = (res.headers.get("content-type") ?? "").includes("event-stream");
    if (!res.body || !isSse) return res; // errors already shaped
    return reqCacheTap(
      wantStream ? toChatCompletionStream(res, String(raw.model)) : await toChatCompletionJson(res, String(raw.model)),
      ck,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    ctx.finish({ accountId: null, servedModel: ctx.model, status: 500, error: msg });
    return jsonError(500, redact(msg));
  }
}

async function handleImages(req: Request, kind: "generations" | "edits"): Promise<Response> {
  const contentType = req.headers.get("content-type") ?? "application/json";
  let bytes: Uint8Array;
  try {
    bytes = await readBodyBytes(req);
  } catch (err) {
    return jsonError(400, `invalid request body: ${err instanceof Error ? err.message : String(err)}`, "invalid_request_error");
  }
  const { ctx } = buildContext(req, { model: imageModelOf(bytes, contentType) } as ResponsesRequest);
  try {
    return await chatgptImages(ctx, kind, bytes, contentType);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    ctx.finish({ accountId: null, servedModel: ctx.model, status: 500, error: msg });
    return jsonError(500, redact(msg));
  }
}

async function listModels(): Promise<Response> {
  const all = (await Promise.all(Object.values(providers).map((p) => p.models().catch(() => [])))).flat();
  return Response.json({
    object: "list",
    data: all
      .filter((m) => !m.hidden)
      .map((m) => {
        const contextWindow = Number(m.contextWindow);
        const hasContext = Number.isFinite(contextWindow) && contextWindow > 0;
        return {
          id: m.slug,
          object: "model",
          created: 0,
          owned_by: "ch-relay",
          ...(hasContext
            ? {
                context_window: contextWindow,
                max_context_window: contextWindow,
                auto_compact_token_limit: Math.floor(contextWindow * 0.9),
              }
            : {}),
        };
      }),
  });
}

export function startServer(port: number, hostname = "127.0.0.1") {
  const server = Bun.serve({
    port,
    hostname,
    idleTimeout: 0, // long-running streams
    development: process.env.CH_DEV === "1",
    routes: {
      "/": gui,
      "/healthz": () => Response.json({ ok: true, version: VERSION }),
      "/v1/responses": { POST: (req) => handleResponses(req, false) },
      "/v1/chat/completions": { POST: handleChatCompletions },
      "/v1/responses/compact": { POST: (req) => handleResponses(req, true) },
      "/v1/models": { GET: () => listModels() },
      "/v1/images/generations": { POST: (req) => handleImages(req, "generations") },
      "/v1/images/edits": { POST: (req) => handleImages(req, "edits") },
    },
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname.startsWith("/api/")) return handleApi(req, url);
      // Codex may probe a websocket on /v1/responses; tell it to use HTTP.
      if (req.headers.get("upgrade")?.toLowerCase() === "websocket") return new Response("websocket not supported", { status: 426 });
      return jsonError(404, `no route for ${req.method} ${url.pathname}`, "not_found");
    },
    error(err) {
      log.error("server error", String(err));
      return jsonError(500, "internal error");
    },
  });
  setApiServerInfo(server.port ?? port, startedAt);
  log.info(`ch-relay ${VERSION} listening on http://${hostname}:${server.port}`);
  return server;
}
