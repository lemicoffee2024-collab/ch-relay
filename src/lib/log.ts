const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
type Level = keyof typeof LEVELS;
const threshold = LEVELS[(process.env.CH_LOG as Level) ?? "info"] ?? LEVELS.info;

const ring: Array<{ ts: number; level: Level; msg: string }> = [];

function write(level: Level, msg: string, extra?: unknown) {
  if (LEVELS[level] < threshold) return;
  const line = extra === undefined ? msg : `${msg} ${typeof extra === "string" ? extra : JSON.stringify(extra)}`;
  ring.push({ ts: Date.now(), level, msg: line });
  if (ring.length > 500) ring.shift();
  const out = `[ch-relay] ${new Date().toISOString()} ${level.toUpperCase()} ${line}`;
  if (level === "error" || level === "warn") console.error(out);
  else console.log(out);
}

export const log = {
  debug: (m: string, e?: unknown) => write("debug", m, e),
  info: (m: string, e?: unknown) => write("info", m, e),
  warn: (m: string, e?: unknown) => write("warn", m, e),
  error: (m: string, e?: unknown) => write("error", m, e),
  recent: () => ring.slice(),
};

/** Replace anything that looks like a secret before logging/storing an upstream error. */
export function redact(s: string): string {
  return s
    .replace(/(Bearer\s+)[A-Za-z0-9._\-]+/gi, "$1<redacted>")
    .replace(/\b(sk|rt|ya29|eyJ)[A-Za-z0-9._\-]{16,}/g, "<redacted>")
    .slice(0, 500);
}
