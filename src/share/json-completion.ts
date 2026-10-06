/** Observe a client-owned JSON value without rewriting its schema or bytes.
 * Numbers need a delimiter: a chunk ending in `1` can still become `12e3`.
 * Structural closure is only a candidate; JSON.parse validates the full value.
 */
export class JsonCompletion {
  private chunks: string[] = [];
  private stack: string[] = [];
  private started = false;
  private quoted = false;
  private escaped = false;
  private primitive = false;
  private ended = false;
  private invalid = false;

  feed(delta: string): boolean {
    if (this.invalid) return false;
    this.chunks.push(delta);
    for (const c of delta) {
      if (this.ended) {
        if (!/[\x20\t\r\n]/.test(c)) this.invalid = true;
        continue;
      }
      if (this.quoted) {
        if (this.escaped) this.escaped = false;
        else if (c === "\\") this.escaped = true;
        else if (c === '"') {
          this.quoted = false;
          if (this.stack.length === 0) this.ended = true;
        }
        continue;
      }
      const whitespace = /[\x20\t\r\n]/.test(c);
      if (!this.started) {
        if (whitespace) continue;
        this.started = true;
        this.primitive = c !== "{" && c !== "[" && c !== '"';
      }
      if (this.primitive) {
        if (whitespace) this.ended = true;
        continue;
      }
      if (c === '"') this.quoted = true;
      else if (c === "{") this.stack.push("}");
      else if (c === "[") this.stack.push("]");
      else if (c === "}" || c === "]") {
        if (this.stack.pop() !== c) this.invalid = true;
        if (this.stack.length === 0) this.ended = true;
      }
    }
    if (!this.ended || this.invalid) return false;
    try {
      JSON.parse(this.chunks.join(""));
      return true;
    } catch {
      this.invalid = true;
      return false;
    }
  }
}
