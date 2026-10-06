// Keeps the real upstream model id out of everything a share user can observe.


/** Real wire id -> the name share users see. Auto Review stays masked: it is only
 *  ever reached as an internal fallback, never a customer-facing model. */
const PUBLIC_WIRE: Record<string, string> = {
  "codex-auto-review": "gpt-6-astra",
};

function wireRegex(map: Record<string, string>): RegExp {
  const keys = Object.keys(map);
  if (!keys.length) return /$a/g; // never matches
  return new RegExp(`\\b(${keys.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\b`, "g");
}

const WIRE_RE = wireRegex(PUBLIC_WIRE);

export function publicWireName(wire: string): string {
  return PUBLIC_WIRE[wire] ?? wire;
}

export function sanitizeText(text: string): string {
  return text.replace(WIRE_RE, (w) => PUBLIC_WIRE[w] ?? w);
}

/**
 * Line-buffered SSE rewriter. Only complete lines are emitted, so a wire id split
 * across chunks is still caught; `atBoundary` tells when a keep-alive comment can be
 * injected without landing inside an event.
 *
 * `extra` maps this request's wire id -> the slug the client asked for, so
 * `response.model` echoes their alias and no real model id leaks downstream.
 */
export class SseRewriter {
  private decoder = new TextDecoder();
  private encoder = new TextEncoder();
  private partial = "";
  private tail = "\n\n";
  private readonly map: Record<string, string>;
  private readonly re: RegExp;

  constructor(extra: Record<string, string> = {}) {
    this.map = { ...PUBLIC_WIRE };
    // Identity mappings would defeat the mask (e.g. a bare "codex-auto-review"
    // request), and a value still containing a masked wire id (e.g.
    // "openai/codex-auto-review") would leak it right back.
    for (const [k, v] of Object.entries(extra)) {
      if (k === v) continue;
      if (Object.keys(PUBLIC_WIRE).some((w) => v.includes(w))) continue;
      this.map[k] = v;
    }
    this.re = wireRegex(this.map);
  }

  push(chunk: Uint8Array): Uint8Array {
    return this.emit(this.decoder.decode(chunk, { stream: true }), false);
  }

  flush(): Uint8Array {
    return this.emit(this.decoder.decode(), true);
  }

  atBoundary(): boolean {
    return this.partial === "" && this.tail.endsWith("\n\n");
  }

  private emit(text: string, final: boolean): Uint8Array {
    const all = this.partial + text;
    const cut = final ? all.length : all.lastIndexOf("\n") + 1;
    this.partial = all.slice(cut);
    const out = this.sanitize(all.slice(0, cut));
    if (out) this.tail = (this.tail + out).slice(-2);
    return this.encoder.encode(out);
  }

  private sanitize(text: string): string {
    return text.replace(this.re, (w) => this.map[w] ?? w);
  }
}

export const KEEPALIVE = new TextEncoder().encode(": keep-alive\n\n");
