// Remote admin console: same GUI + /api as the main port, but behind a
// username/password login. Binds 127.0.0.1; expose it with a tunnel
// (e.g. `tailscale funnel --bg --https=8443 10400`). No /v1 data plane here.

import gui from "../../gui/index.html";
import { handleApi, setApiServerInfo } from "../api.ts";
import { jsonError } from "../lib/sse.ts";
import { log } from "../lib/log.ts";
import {
  clearSessionCookie,
  createSession,
  destroySession,
  loginFailed,
  loginLocked,
  loginSucceeded,
  sessionCookie,
  sessionTokenFrom,
  sessionUser,
  verifyAdmin,
} from "./auth.ts";

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function loginPage(error?: string): Response {
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>ch-relay — Sign in</title>
<meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#f5f5f7;color:#1d1d1f">
<form method="post" action="/login" style="padding:40px 44px;background:#fff;border-radius:18px;box-shadow:0 4px 24px rgba(0,0,0,.08);width:320px">
<h1 style="font-size:20px;font-weight:600;margin:0 0 6px;text-align:center">ch-relay</h1>
<p style="font-size:13px;color:#6e6e73;margin:0 0 22px;text-align:center">Đăng nhập để quản lý</p>
${error ? `<p style="font-size:13px;color:#ff3b30;margin:0 0 14px;text-align:center">${esc(error)}</p>` : ""}
<input name="username" autocomplete="username" required placeholder="Tên đăng nhập" style="width:100%;box-sizing:border-box;font-size:14px;padding:11px 14px;margin-bottom:12px;border:1px solid #d2d2d7;border-radius:10px">
<input name="password" type="password" autocomplete="current-password" required placeholder="Mật khẩu" style="width:100%;box-sizing:border-box;font-size:14px;padding:11px 14px;margin-bottom:18px;border:1px solid #d2d2d7;border-radius:10px">
<button type="submit" style="width:100%;font-size:14px;font-weight:600;padding:11px;border:0;border-radius:10px;background:#0071e3;color:#fff;cursor:pointer">Đăng nhập</button>
</form></body></html>`;
  return new Response(html, { status: error ? 401 : 200, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}

function redirect(to: string, cookie?: string): Response {
  const headers = new Headers({ location: to, "cache-control": "no-store" });
  if (cookie) headers.set("set-cookie", cookie);
  return new Response(null, { status: 302, headers });
}

function clientIp(req: Request, server: { requestIP(req: Request): { address: string } | null }): string {
  return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || server.requestIP(req)?.address || "unknown";
}

async function handleLoginPost(req: Request, server: { requestIP(req: Request): { address: string } | null }): Promise<Response> {
  // Same origin rule as the management API: no cross-site form posts.
  const origin = req.headers.get("origin");
  const url = new URL(req.url);
  if (origin) {
    const proto = req.headers.get("x-forwarded-proto") ?? url.protocol.replace(/:$/, "");
    const host = req.headers.get("x-forwarded-host") ?? url.host;
    if (origin !== `${proto}://${host}` && origin !== url.origin) return jsonError(403, "foreign origin", "forbidden");
  }
  const ip = clientIp(req, server);
  if (loginLocked(ip)) return loginPage("Quá nhiều lần sai, thử lại sau 15 phút.");

  let username = "";
  let password = "";
  const ct = req.headers.get("content-type") ?? "";
  if (ct.includes("application/json")) {
    const j = (await req.json().catch(() => ({}))) as { username?: string; password?: string };
    username = j.username ?? "";
    password = j.password ?? "";
  } else {
    const f = await req.formData().catch(() => null);
    username = String(f?.get("username") ?? "");
    password = String(f?.get("password") ?? "");
  }

  if (!(await verifyAdmin(username, password))) {
    loginFailed(ip);
    log.warn(`admin login failed user=${username} ip=${ip}`);
    return loginPage("Sai tài khoản hoặc mật khẩu.");
  }
  loginSucceeded(ip);
  log.info(`admin login ok user=${username} ip=${ip}`);
  return redirect("/", sessionCookie(req, createSession(username)));
}

const ADMIN_OPEN = process.env.CH_ADMIN_OPEN === "1";

export function startAdminServer(port: number, hostname = "127.0.0.1", opts: { mainPort?: number } = {}) {
  // /api/sync and status should report the port Codex actually talks to (the main
  // listener), not ours — relevant when this console runs without a local proxy.
  if (opts.mainPort) setApiServerInfo(opts.mainPort, Date.now());
  const server: ReturnType<typeof Bun.serve> = Bun.serve({
    port,
    hostname,
    routes: {
      "/healthz": () => Response.json({ ok: true }),
      "/": gui,
      "/login": {
        GET: (req) => (sessionUser(req) ? redirect("/") : loginPage()),
        POST: (req) => handleLoginPost(req, server),
      },
      "/logout": (req) => {
        const token = sessionTokenFrom(req);
        if (token) destroySession(token);
        return redirect("/login", clearSessionCookie());
      },
    },
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname.startsWith("/api/")) {
        // CH_ADMIN_OPEN=1: skip session auth on the loopback console — used by
        // customer installs where anyone reaching this port owns the machine.
        if (!ADMIN_OPEN && !sessionUser(req)) return jsonError(401, "Sign in required.", "unauthenticated");
        return handleApi(req, url);
      }
      if (req.headers.get("upgrade")?.toLowerCase() === "websocket") return new Response("websocket not supported", { status: 426 });
      return jsonError(404, "not found", "not_found");
    },
    error(err) {
      log.error("admin server error", String(err));
      return jsonError(500, "internal error");
    },
  });
  log.info(`ch-relay admin console on http://${hostname}:${server.port}`);
  return server;
}
