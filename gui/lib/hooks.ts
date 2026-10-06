import { useCallback, useEffect, useRef, useState } from "react";
import { errMsg } from "./api.ts";

export interface Polled<T> {
  data: T | undefined;
  error: string | null;
  loading: boolean;
  reload: () => Promise<void>;
  /** Replace data locally (optimistic update). */
  mutate: (fn: (prev: T | undefined) => T | undefined) => void;
}

/**
 * Fetch `fn` now and every `intervalMs` (paused while the tab is hidden).
 * Re-runs immediately when `key` changes.
 */
export function usePoll<T>(fn: () => Promise<T>, intervalMs: number, key: unknown = null): Polled<T> {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const seq = useRef(0);

  const reload = useCallback(async () => {
    const my = ++seq.current;
    try {
      const d = await fnRef.current();
      if (my !== seq.current) return;
      setData(d);
      setError(null);
    } catch (e) {
      if (my !== seq.current) return;
      setError(errMsg(e));
    } finally {
      if (my === seq.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    setLoading(true);
    void reload();
    if (!intervalMs) return;
    const t = setInterval(() => {
      if (document.visibilityState === "visible") void reload();
    }, intervalMs);
    const onVis = () => document.visibilityState === "visible" && void reload();
    document.addEventListener("visibilitychange", onVis);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [reload, intervalMs, key]);

  const mutate = useCallback((f: (prev: T | undefined) => T | undefined) => setData((p) => f(p)), []);
  return { data, error, loading, reload, mutate };
}

/** Current time, ticking every `ms`. */
export function useNow(ms = 1000): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

/** `#/route?a=1&b=2` -> URLSearchParams(a=1&b=2). */
export function hashParams(): URLSearchParams {
  const h = location.hash;
  const i = h.indexOf("?");
  return new URLSearchParams(i >= 0 ? h.slice(i + 1) : "");
}

/** Hash for a route with optional params: use as an `href`. */
export function routeHref(route: string, params: Record<string, string | undefined> = {}): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) p.set(k, v);
  const s = p.toString();
  return `#/${route}${s ? `?${s}` : ""}`;
}

const PARAMS_EVENT = "ch-hash-params";

/**
 * Query parameters after the route in the hash, as state. Updates replace the history entry
 * (filters are not navigation) and never re-mount the page.
 */
export function useHashParams(): [URLSearchParams, (patch: Record<string, string | undefined>) => void] {
  const [params, setParams] = useState(hashParams);
  useEffect(() => {
    const on = () => setParams(hashParams());
    window.addEventListener("hashchange", on);
    window.addEventListener(PARAMS_EVENT, on);
    return () => {
      window.removeEventListener("hashchange", on);
      window.removeEventListener(PARAMS_EVENT, on);
    };
  }, []);
  const update = useCallback((patch: Record<string, string | undefined>) => {
    const cur = hashParams();
    for (const [k, v] of Object.entries(patch)) {
      if (v) cur.set(k, v);
      else cur.delete(k);
    }
    const route = location.hash.replace(/^#\/?/, "").split(/[?/]/)[0] ?? "";
    const s = cur.toString();
    history.replaceState(null, "", `#/${route}${s ? `?${s}` : ""}`);
    window.dispatchEvent(new Event(PARAMS_EVENT));
  }, []);
  return [params, update];
}

export function useHashRoute<T extends string>(routes: readonly T[], fallback: T): [T, (r: T) => void] {
  const read = () => {
    const h = (location.hash.replace(/^#\/?/, "").split(/[?/]/)[0] ?? "") as T;
    return routes.includes(h) ? h : fallback;
  };
  const [route, setRoute] = useState<T>(read);
  useEffect(() => {
    const on = () => setRoute(read());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const go = useCallback((r: T) => {
    location.hash = `/${r}`;
  }, []);
  return [route, go];
}
