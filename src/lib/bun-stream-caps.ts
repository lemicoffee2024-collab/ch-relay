/**
 * Bun versions before 1.4.0 (and every prerelease) are unsafe for the
 * ReadableStream async-pull/cancel sequence used by the proxy relay.
 *
 * Keep this small and injectable: callers/tests can pass the runtime version
 * they need to evaluate instead of depending on the process-global Bun.
 */
export function isBunAsyncPullCancelUnsafe(version: string = Bun.version): boolean {
  const text = version.trim();
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(text);
  // Unknown runtimes are treated conservatively; this helper is a safety gate.
  if (!match) return true;
  // A prerelease may not contain the upstream stream fix yet.
  if (match[4]) return true;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  return major < 1 || (major === 1 && minor < 4);
}
