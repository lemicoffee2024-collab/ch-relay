/** Codex compresses request bodies (zstd) when talking to the ChatGPT backend. */
export async function readBodyBytes(req: Request): Promise<Uint8Array> {
  const raw = new Uint8Array(await req.arrayBuffer());
  const enc = (req.headers.get("content-encoding") ?? "").toLowerCase().trim();
  let bytes: Uint8Array = raw;
  if (enc === "zstd") bytes = Bun.zstdDecompressSync(raw);
  else if (enc === "gzip" || enc === "x-gzip") bytes = Bun.gunzipSync(raw);
  else if (enc === "deflate") bytes = Bun.inflateSync(raw);
  else if (enc === "br") bytes = (await import("node:zlib")).brotliDecompressSync(raw);
  else if (enc && enc !== "identity") throw new Error(`unsupported content-encoding ${enc}`);
  return bytes;
}

export async function readBody(req: Request): Promise<string> {
  return new TextDecoder().decode(await readBodyBytes(req));
}

/** Image model named in a JSON image request (multipart bodies are not parsed). */
export function imageModelOf(bytes: Uint8Array, contentType: string): string {
  if (!contentType.includes("json")) return "gpt-image";
  try {
    const m = JSON.parse(new TextDecoder().decode(bytes))?.model;
    return typeof m === "string" && m ? m : "gpt-image";
  } catch {
    return "gpt-image";
  }
}
