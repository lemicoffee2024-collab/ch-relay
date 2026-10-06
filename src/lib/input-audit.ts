import { log } from "./log.ts";
import type { RequestOutcome } from "../types.ts";

const json = (value: unknown): string => JSON.stringify(value) ?? "";
const bytes = (value: unknown): number => Buffer.byteLength(json(value), "utf8");
const textChars = (value: any): number => {
  if (typeof value === "string") return value.length;
  if (!Array.isArray(value)) return 0;
  return value.reduce((n, part) => n + (typeof part?.text === "string" ? part.text.length : 0), 0);
};

/** Observable payload sizes, NOT a tokenizer. Opaque reasoning/images are not
 * converted to tokens. Schemas include JSON syntax; text counts UTF-16 units. */
export function measureInput(body: Record<string, any>) {
  const sizes = {
    json_bytes: bytes(body),
    instructions_chars: textChars(body.instructions),
    messages_chars: typeof body.input === "string" ? body.input.length : 0,
    tool_output_chars: 0,
    tool_call_chars: 0,
    schema_chars: Array.isArray(body.tools) ? json(body.tools).length : 0,
    repeated_schema_chars: 0,
    reasoning_json_bytes: 0,
    opaque_state_json_bytes: 0,
    reasoning_items: 0,
    items: Array.isArray(body.input) ? body.input.length : 0,
    prompt_cache_key_present: typeof body.prompt_cache_key === "string" && body.prompt_cache_key.length > 0,
  };
  const schemas = new Set<string>();
  for (const item of Array.isArray(body.input) ? body.input : []) {
    if (!item || typeof item !== "object") continue;
    switch (item.type) {
      case undefined:
      case "agent_message":
      case "message": sizes.messages_chars += textChars(item.content); break;
      case "function_call_output":
      case "custom_tool_call_output": sizes.tool_output_chars += textChars(item.output); break;
      case "function_call": sizes.tool_call_chars += textChars(item.arguments); break;
      case "custom_tool_call": sizes.tool_call_chars += textChars(item.input); break;
      case "additional_tools": {
        const schema = json(item.tools);
        sizes.schema_chars += schema.length;
        if (schemas.has(schema)) sizes.repeated_schema_chars += schema.length;
        schemas.add(schema);
        break;
      }
      case "reasoning":
        sizes.reasoning_items++;
        sizes.reasoning_json_bytes += bytes(item);
        break;
      case "compaction": sizes.opaque_state_json_bytes += bytes(item); break;
    }
  }
  return { ...sizes, visible_chars: sizes.instructions_chars + sizes.messages_chars +
    sizes.tool_output_chars + sizes.tool_call_chars + sizes.schema_chars };
}

export type InputSizes = ReturnType<typeof measureInput>;

export function inputDelta(before: InputSizes, after: InputSizes) {
  const visible = before.visible_chars - after.visible_chars;
  return {
    json_bytes_removed: before.json_bytes - after.json_bytes,
    visible_chars_removed: visible,
    visible_chars_removed_pct: before.visible_chars
      ? Math.round(visible / before.visible_chars * 10000) / 100 : 0,
    // Exact upstream token savings cannot be inferred from bytes/characters.
    input_token_savings_pct: null,
  };
}

/** Numeric-only diagnostic. Never records prompts, schema contents, cache keys,
 * credentials, encrypted reasoning or a raw request/response. Disable with
 * CODE_HOLE_INPUT_AUDIT=0 (code-hole) or CH_INPUT_AUDIT=0 (ch-relay). */
export class InputAudit {
  private readonly id = crypto.randomUUID();
  private previous?: InputSizes;
  private attempts = 0;
  private finished = false;
  constructor(
    private readonly lane: string,
    private readonly model: string,
    private readonly emit: (event: Record<string, unknown>) => void = event => log.info("inputaudit " + JSON.stringify(event)),
    private readonly enabled = process.env.CH_INPUT_AUDIT !== "0",
  ) {}

  capture(stage: string, body: Record<string, any>) {
    if (!this.enabled) return;
    const sizes = measureInput(body);
    this.emit({ id: this.id, lane: this.lane, model: this.model, stage, ...sizes,
      ...(this.previous ? inputDelta(this.previous, sizes) : {}) });
    this.previous = sizes;
  }

  /** Called immediately before EVERY fetch, including fallbacks/continuations. */
  sent(bodyText: string) {
    if (!this.enabled) return;
    this.attempts++;
    const body = JSON.parse(bodyText) as Record<string, any>;
    this.emit({ id: this.id, lane: this.lane, model: this.model, stage: "upstream_attempt",
      attempt: this.attempts, ...measureInput(body) });
  }

  finish(outcome: RequestOutcome) {
    if (!this.enabled || this.finished) return;
    this.finished = true;
    const u = outcome.usage;
    // Early-cut completion envelopes use zero input. They are NOT evidence of
    // zero consumption. Cache counters are subsets of total input, never extra.
    const observed = !!u && Number.isFinite(u.inputTokens) && u.inputTokens > 0;
    const cached = observed && Number.isFinite(u?.cachedInputTokens)
      ? u!.cachedInputTokens! : null;
    this.emit({ id: this.id, lane: this.lane, model: this.model, stage: "done",
      status: outcome.status, upstream_attempts: this.attempts,
      served_model: outcome.servedModel,
      usage_source: observed ? "reported" : "missing_or_synthetic",
      input_tokens: observed ? u!.inputTokens : null,
      cached_tokens: cached,
      uncached_input_tokens: observed && cached !== null ? Math.max(0, u!.inputTokens - cached) : null,
      input_token_savings_pct: null });
  }
}

