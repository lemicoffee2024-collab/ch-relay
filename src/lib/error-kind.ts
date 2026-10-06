// One classifier for "what went wrong" shared by the API and the GUI (pure, no imports).
// OpenAI often opens the stream with HTTP 200 and reports the failure inside it, so the
// error text matters as much as the status code.

export type ErrorKind = "ok" | "overload" | "rate" | "cancel" | "network" | "model" | "auth" | "other";

/** Kinds worth retrying / not the user's fault: shown in orange rather than red. */
export const SOFT_KINDS: ReadonlySet<ErrorKind> = new Set(["overload", "rate", "cancel"]);

export function errorKind(status: number, error?: string | null): ErrorKind {
  const e = (error ?? "").toLowerCase();
  if (!e) {
    if (status < 400) return "ok";
    if (status === 429) return "rate";
    if (status === 499) return "cancel";
    if (status === 401 || status === 403) return "auth";
    return "other";
  }
  if (e.includes("overload")) return "overload";
  if (e.includes("rate") || e.includes("slow down") || e.includes("too many") || status === 429) return "rate";
  if (e.includes("cancel") || status === 499) return "cancel";
  // Model before network: "upstream reported model X" contains the letters "stream".
  if (e.includes("not supported") || e.includes("not available") || e.includes("model_mismatch") || e.includes("reported model")) return "model";
  if (/\bstream\b|socket|network|closed|unreachable/.test(e)) return "network";
  if (status === 401 || status === 403 || e.includes("unauthorized") || e.includes("token expired")) return "auth";
  return "other";
}

export const ERROR_KIND_ORDER: ErrorKind[] = ["overload", "rate", "network", "model", "auth", "cancel", "other"];
