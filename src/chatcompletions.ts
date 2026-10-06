// /v1/chat/completions compatibility shim: convert the request into a
// Responses API body, run it through the normal provider pipeline (autocut
// included), and translate the Responses SSE stream back into
// chat.completion.chunk frames (or one JSON response for stream=false).

import type { ResponsesRequest } from "./types.ts";

let seq = 0;
const rid = () => `chatcmpl-ch${Date.now().toString(36)}${(seq++).toString(36)}`;

type Msg = Record<string, any>;

function contentText(c: any): string {
  if (typeof c === "string") return c;
  if (!Array.isArray(c)) return "";
  return c.map((p) => (typeof p === "string" ? p : p?.type === "text" ? p.text ?? "" : "")).join("");
}

/** chat.completions body -> Responses request body. */
export function toResponsesBody(raw: Record<string, any>): ResponsesRequest {
  const input: any[] = [];
  const instructions: string[] = [];
  for (const m of (raw.messages ?? []) as Msg[]) {
    const role = m?.role;
    if (role === "system" || role === "developer") {
      const t = contentText(m.content);
      if (t) instructions.push(t);
      continue;
    }
    if (role === "tool") {
      input.push({
        type: "function_call_output",
        call_id: m.tool_call_id ?? m.call_id ?? "",
        output: contentText(m.content),
      });
      continue;
    }
    if (role === "assistant" && Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) {
        const fn = tc?.function ?? {};
        input.push({
          type: "function_call",
          call_id: tc.id ?? "",
          name: fn.name ?? "",
          arguments: typeof fn.arguments === "string" ? fn.arguments : JSON.stringify(fn.arguments ?? {}),
        });
      }
    }
    const t = contentText(m.content);
    if (!t && !(role === "assistant" && m.tool_calls?.length)) continue;
    input.push({
      type: "message",
      role: role === "assistant" ? "assistant" : "user",
      content: [{ type: role === "assistant" ? "output_text" : "input_text", text: t }],
    });
  }
  const tools = Array.isArray(raw.tools)
    ? raw.tools.map((t: any) =>
        t?.type === "function" && t.function
          ? { type: "function", name: t.function.name, description: t.function.description ?? "", parameters: t.function.parameters ?? {} }
          : t,
      )
    : undefined;
  const out: Record<string, any> = {
    model: raw.model,
    store: false,
    stream: true,
    input,
  };
  if (instructions.length) out.instructions = instructions.join("\n\n");
  if (tools?.length) out.tools = tools;
  const effort = raw.reasoning_effort ?? raw.reasoning?.effort;
  if (effort) out.reasoning = { effort };
  return out as ResponsesRequest;
}

interface ChatToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

interface Frames {
  text: string;
  toolCalls: ChatToolCall[];
  usage: any;
  model: string | undefined;
  failed: string | undefined;
}

/** Parse a full Responses SSE body into one compact result. */
async function collectFrames(res: Response): Promise<Frames> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const out: Frames = { text: "", toolCalls: [], usage: undefined, model: undefined, failed: undefined };
  const callIndex = new Map<string, number>();
  for (;;) {
    let nl = buf.indexOf("\n\n");
    while (nl >= 0) {
      const raw = buf.slice(0, nl);
      buf = buf.slice(nl + 2);
      let data = "";
      for (const line of raw.split("\n")) if (line.startsWith("data:")) data += line.slice(5).replace(/^ /, "");
      nl = buf.indexOf("\n\n");
      if (!data || data === "[DONE]") continue;
      let j: any;
      try {
        j = JSON.parse(data);
      } catch {
        continue;
      }
      const t = j?.type;
      if (t === "response.output_text.delta") out.text += String(j.delta ?? "");
      else if (t === "response.output_item.done" && (j.item?.type === "function_call" || j.item?.type === "custom_tool_call")) {
        const it = j.item;
        const idx = callIndex.get(it.id) ?? out.toolCalls.length;
        callIndex.set(it.id, idx);
        out.toolCalls[idx] = {
          id: it.call_id ?? it.id ?? `call_${idx}`,
          type: "function",
          function: { name: it.name ?? "tool", arguments: it.arguments ?? it.input ?? "" },
        };
      } else if (t === "response.completed" || t === "response.incomplete") {
        out.usage = j.response?.usage;
        if (typeof j.response?.model === "string") out.model = j.response.model;
      } else if (t === "response.failed" || t === "error") {
        out.failed = JSON.stringify(j.response?.error ?? j.error ?? "upstream error").slice(0, 300);
      }
    }
    const { value, done } = await reader.read();
    if (done) break;
    if (value?.byteLength) buf += decoder.decode(value, { stream: true });
  }
  return out;
}

/** Non-streaming reply: drain the upstream stream, emit one chat.completion. */
export async function toChatCompletionJson(res: Response, model: string): Promise<Response> {
  const f = await collectFrames(res);
  const msg: Record<string, any> = { role: "assistant", content: f.text || null };
  if (f.toolCalls.length) msg.tool_calls = f.toolCalls;
  const u = f.usage;
  return Response.json({
    id: rid(),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: f.model ?? model,
    choices: [{ index: 0, message: msg, finish_reason: f.failed ? "stop" : f.toolCalls.length ? "tool_calls" : "stop" }],
    usage: u
      ? {
          prompt_tokens: u.input_tokens ?? 0,
          completion_tokens: u.output_tokens ?? 0,
          total_tokens: u.total_tokens ?? (u.input_tokens ?? 0) + (u.output_tokens ?? 0),
        }
      : { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  });
}

/** Wrap a Responses SSE stream, emitting chat.completion.chunk frames. */
export function toChatCompletionStream(res: Response, model: string): Response {
  const id = rid();
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const reader = res.body!.getReader();
  let buf = "";
  let roleSent = false;
  let openCallIdx = -1;
  let toolCount = 0;
  let doneSent = false;

  const chunk = (delta: Record<string, any>, finish: string | null = null, usage?: any) =>
    `data: ${JSON.stringify({
      id,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, delta, finish_reason: finish, logprobs: null }],
      ...(usage ? { usage } : {}),
    })}\n\n`;

  const finishNow = (controller: ReadableStreamDefaultController<Uint8Array>, u: any) => {
    if (doneSent) return;
    doneSent = true;
    controller.enqueue(
      encoder.encode(
        chunk({}, toolCount ? "tool_calls" : "stop", u
          ? {
              prompt_tokens: u.input_tokens ?? 0,
              completion_tokens: u.output_tokens ?? 0,
              total_tokens: u.total_tokens ?? (u.input_tokens ?? 0) + (u.output_tokens ?? 0),
            }
          : undefined),
      ),
    );
    controller.enqueue(encoder.encode("data: [DONE]\n\n"));
    controller.close();
    // Do NOT reader.cancel() here — autocut calls finish() after emitting its
    // terminal frame; cancelling mid-close races it into a bogus 499 outcome.
  };

  const pump = new ReadableStream<Uint8Array>({
    async pull(controller) {
      for (;;) {
        let nl = buf.indexOf("\n\n");
        while (nl >= 0) {
          const raw = buf.slice(0, nl);
          buf = buf.slice(nl + 2);
          let data = "";
          for (const line of raw.split("\n")) if (line.startsWith("data:")) data += line.slice(5).replace(/^ /, "");
          nl = buf.indexOf("\n\n");
          if (!data || data === "[DONE]") continue;
          let j: any;
          try {
            j = JSON.parse(data);
          } catch {
            continue;
          }
          const t = j?.type;
          if (!roleSent && (t === "response.output_text.delta" || t === "response.output_item.added")) {
            roleSent = true;
            controller.enqueue(encoder.encode(chunk({ role: "assistant" })));
          }
          if (t === "response.output_text.delta") {
            controller.enqueue(encoder.encode(chunk({ content: String(j.delta ?? "") })));
          } else if (
            t === "response.output_item.added" &&
            (j.item?.type === "function_call" || j.item?.type === "custom_tool_call")
          ) {
            // Open the tool_call with id+name; argument deltas fill it in.
            openCallIdx = toolCount++;
            controller.enqueue(
              encoder.encode(
                chunk({
                  tool_calls: [
                    {
                      index: openCallIdx,
                      id: j.item.call_id ?? j.item.id ?? `call_${openCallIdx}`,
                      type: "function",
                      function: { name: j.item.name ?? "tool", arguments: "" },
                    },
                  ],
                }),
              ),
            );
          } else if (
            (t === "response.function_call_arguments.delta" || t === "response.custom_tool_call_input.delta") &&
            openCallIdx >= 0
          ) {
            controller.enqueue(
              encoder.encode(
                chunk({ tool_calls: [{ index: openCallIdx, function: { arguments: String(j.delta ?? "") } }] }),
              ),
            );
          } else if (t === "response.completed" || t === "response.incomplete") {
            finishNow(controller, j.response?.usage);
            return;
          } else if (t === "response.failed" || t === "error") {
            finishNow(controller, undefined);
            return;
          }
        }
        const { value, done } = await reader.read();
        if (done) {
          finishNow(controller, undefined);
          return;
        }
        if (value?.byteLength) buf += decoder.decode(value, { stream: true });
      }
    },
    cancel(reason) {
      void reader.cancel(reason).catch(() => {});
    },
  });
  return new Response(pump, {
    status: res.status,
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
  });
}
