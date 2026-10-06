import type { Usage } from "../types.ts";

// ---------------------------------------------------------------------------
// SSE parsing (upstream -> frames)
// ---------------------------------------------------------------------------

export interface SseFrame {
  event?: string;
  data: string;
}

/** Parse an SSE byte stream into frames. Comment/heartbeat lines are skipped. */
export async function* parseSse(body: ReadableStream<Uint8Array>): AsyncGenerator<SseFrame> {
  const decoder = new TextDecoder();
  let buf = "";
  let event: string | undefined;
  let data: string[] = [];
  const reader = body.getReader();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        let line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        if (line === "") {
          if (data.length) yield { event, data: data.join("\n") };
          event = undefined;
          data = [];
        } else if (line.startsWith(":")) {
          // comment / heartbeat
        } else if (line.startsWith("event:")) {
          event = line.slice(6).trim();
        } else if (line.startsWith("data:")) {
          data.push(line.slice(5).replace(/^ /, ""));
        }
      }
    }
    buf += decoder.decode();
    if (buf.trim().startsWith("data:")) data.push(buf.trim().slice(5).replace(/^ /, ""));
    if (data.length) yield { event, data: data.join("\n") };
  } finally {
    reader.releaseLock();
  }
}

// ---------------------------------------------------------------------------
// Responses SSE builder (adapter events -> OpenAI Responses stream for Codex)
// ---------------------------------------------------------------------------

/** Normalised events that translating adapters (Antigravity, OpenCode chat) emit. */
export type AdapterEvent =
  | { type: "text_delta"; text: string }
  | { type: "reasoning_delta"; text: string }
  | {
      type: "tool_call";
      callId: string;
      name: string;
      /** Full JSON arguments string. */
      arguments: string;
      /** Extra fields put on the function_call item (e.g. extra_content.google.thought_signature). */
      extra?: Record<string, unknown>;
    }
  | { type: "usage"; usage: Usage }
  | { type: "finish"; reason: "stop" | "length" | "content_filter" }
  | { type: "error"; message: string; code?: string };

function rid(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "")}`;
}

export function usageToResponses(u: Usage | undefined) {
  const input = u?.inputTokens ?? 0;
  const output = u?.outputTokens ?? 0;
  return {
    input_tokens: input,
    input_tokens_details: { cached_tokens: u?.cachedInputTokens ?? 0 },
    output_tokens: output,
    output_tokens_details: { reasoning_tokens: u?.reasoningOutputTokens ?? 0 },
    total_tokens: input + output,
  };
}

type OpenItem =
  | { kind: "message"; id: string; index: number; text: string }
  | { kind: "reasoning"; id: string; index: number; text: string };

/**
 * Stateful converter: feed AdapterEvents, get SSE text chunks in OpenAI Responses format.
 * Text/reasoning items are opened lazily and closed when another item starts.
 */
export class ResponsesStreamBuilder {
  readonly responseId = rid("resp");
  private seq = 0;
  private started = false;
  private finished = false;
  private open: OpenItem | null = null;
  private output: Array<Record<string, unknown>> = [];
  private usage: Usage | undefined;
  private readonly createdAt = Math.floor(Date.now() / 1000);

  constructor(private readonly model: string) {}

  get isFinished(): boolean {
    return this.finished;
  }

  get hasOutput(): boolean {
    return this.output.length > 0 || this.open !== null;
  }

  get finalUsage(): Usage | undefined {
    return this.usage;
  }

  private ev(type: string, payload: Record<string, unknown>): string {
    return `event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: this.seq++, ...payload })}\n\n`;
  }

  private responseObj(status: string, extra: Record<string, unknown> = {}) {
    return {
      id: this.responseId,
      object: "response",
      created_at: this.createdAt,
      status,
      model: this.model,
      output: status === "in_progress" ? [] : this.output,
      usage: status === "in_progress" ? null : usageToResponses(this.usage),
      ...extra,
    };
  }

  start(): string {
    if (this.started) return "";
    this.started = true;
    return (
      this.ev("response.created", { response: this.responseObj("in_progress") }) +
      this.ev("response.in_progress", { response: this.responseObj("in_progress") })
    );
  }

  private closeOpen(): string {
    const o = this.open;
    if (!o) return "";
    this.open = null;
    if (o.kind === "message") {
      const item = {
        id: o.id,
        type: "message",
        status: "completed",
        role: "assistant",
        content: [{ type: "output_text", text: o.text, annotations: [] }],
      };
      this.output.push(item);
      return (
        this.ev("response.output_text.done", { item_id: o.id, output_index: o.index, content_index: 0, text: o.text }) +
        this.ev("response.content_part.done", {
          item_id: o.id,
          output_index: o.index,
          content_index: 0,
          part: { type: "output_text", text: o.text, annotations: [] },
        }) +
        this.ev("response.output_item.done", { output_index: o.index, item })
      );
    }
    const item = { id: o.id, type: "reasoning", summary: [{ type: "summary_text", text: o.text }] };
    this.output.push(item);
    return (
      this.ev("response.reasoning_summary_text.done", { item_id: o.id, output_index: o.index, summary_index: 0, text: o.text }) +
      this.ev("response.reasoning_summary_part.done", {
        item_id: o.id,
        output_index: o.index,
        summary_index: 0,
        part: { type: "summary_text", text: o.text },
      }) +
      this.ev("response.output_item.done", { output_index: o.index, item })
    );
  }

  private nextIndex(): number {
    return this.output.length + (this.open ? 1 : 0);
  }

  push(e: AdapterEvent): string {
    if (this.finished) return "";
    let out = this.start();
    switch (e.type) {
      case "text_delta": {
        if (!e.text) return out;
        if (this.open?.kind !== "message") {
          out += this.closeOpen();
          const id = rid("msg");
          const index = this.nextIndex();
          this.open = { kind: "message", id, index, text: "" };
          out +=
            this.ev("response.output_item.added", {
              output_index: index,
              item: { id, type: "message", status: "in_progress", role: "assistant", content: [] },
            }) +
            this.ev("response.content_part.added", {
              item_id: id,
              output_index: index,
              content_index: 0,
              part: { type: "output_text", text: "", annotations: [] },
            });
        }
        const o = this.open!;
        o.text += e.text;
        out += this.ev("response.output_text.delta", { item_id: o.id, output_index: o.index, content_index: 0, delta: e.text });
        return out;
      }
      case "reasoning_delta": {
        if (!e.text) return out;
        if (this.open?.kind !== "reasoning") {
          out += this.closeOpen();
          const id = rid("rs");
          const index = this.nextIndex();
          this.open = { kind: "reasoning", id, index, text: "" };
          out +=
            this.ev("response.output_item.added", { output_index: index, item: { id, type: "reasoning", summary: [] } }) +
            this.ev("response.reasoning_summary_part.added", {
              item_id: id,
              output_index: index,
              summary_index: 0,
              part: { type: "summary_text", text: "" },
            });
        }
        const o = this.open!;
        o.text += e.text;
        out += this.ev("response.reasoning_summary_text.delta", { item_id: o.id, output_index: o.index, summary_index: 0, delta: e.text });
        return out;
      }
      case "tool_call": {
        out += this.closeOpen();
        const id = rid("fc");
        const index = this.nextIndex();
        const base = { id, type: "function_call", call_id: e.callId, name: e.name, ...(e.extra ?? {}) };
        const done = { ...base, arguments: e.arguments, status: "completed" };
        this.output.push(done);
        out +=
          this.ev("response.output_item.added", { output_index: index, item: { ...base, arguments: "", status: "in_progress" } }) +
          this.ev("response.function_call_arguments.delta", { item_id: id, output_index: index, delta: e.arguments }) +
          this.ev("response.function_call_arguments.done", { item_id: id, output_index: index, arguments: e.arguments }) +
          this.ev("response.output_item.done", { output_index: index, item: done });
        return out;
      }
      case "usage":
        this.usage = e.usage;
        return out;
      case "finish": {
        out += this.closeOpen();
        this.finished = true;
        if (e.reason === "stop") return out + this.ev("response.completed", { response: this.responseObj("completed") });
        const reason = e.reason === "length" ? "max_output_tokens" : "content_filter";
        return out + this.ev("response.incomplete", { response: this.responseObj("incomplete", { incomplete_details: { reason } }) });
      }
      case "error": {
        out += this.closeOpen();
        this.finished = true;
        return (
          out +
          this.ev("response.failed", {
            response: this.responseObj("failed", { error: { code: e.code ?? "upstream_error", message: e.message } }),
          })
        );
      }
    }
  }
}

/** Build a streaming SSE Response from an async iterable of SSE text chunks. */
export function sseResponse(chunks: AsyncIterable<string>, onCancel?: () => void): Response {
  const encoder = new TextEncoder();
  let iterator: AsyncIterator<string> | null = null;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      iterator ??= chunks[Symbol.asyncIterator]();
      try {
        const { value, done } = await iterator.next();
        if (done) controller.close();
        else if (value) controller.enqueue(encoder.encode(value));
      } catch (err) {
        controller.error(err);
      }
    },
    async cancel() {
      onCancel?.();
      await iterator?.return?.();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" },
  });
}

/** JSON error in the OpenAI error envelope. */
export function jsonError(status: number, message: string, code = "code_hole_error"): Response {
  return Response.json({ error: { message, type: code, code } }, { status });
}
