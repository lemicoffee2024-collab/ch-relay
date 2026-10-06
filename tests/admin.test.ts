import { beforeAll, expect, test } from "bun:test";
import { useMemoryDb } from "../src/store/db.ts";
import {
  addAdminUser,
  listAdminUsers,
  removeAdminUser,
  sessionCookie,
  sessionUser,
  setAdminPassword,
  verifyAdmin,
} from "../src/admin/auth.ts";
import { startAdminServer } from "../src/admin/server.ts";

beforeAll(() => useMemoryDb());

function req(path: string, init: RequestInit = {}): Request {
  return new Request(`http://127.0.0.1${path}`, init);
}

test("admin user lifecycle", async () => {
  const u = await addAdminUser("tuan", "super-secret-1", "owner");
  expect(u.username).toBe("tuan");
  expect(await verifyAdmin("tuan", "super-secret-1")).toBe(true);
  expect(await verifyAdmin("tuan", "wrong-password")).toBe(false);
  await expect(addAdminUser("tuan", "super-secret-2")).rejects.toThrow("already exists");
  await expect(addAdminUser("x", "super-secret-1")).rejects.toThrow("username");
  await expect(addAdminUser("too-short-pass", "1234567")).rejects.toThrow("8 characters");

  expect(await setAdminPassword("tuan", "new-password-9")).toBe(true);
  expect(await verifyAdmin("tuan", "new-password-9")).toBe(true);
  expect(await verifyAdmin("tuan", "super-secret-1")).toBe(false);

  expect(listAdminUsers().map((x) => x.username)).toContain("tuan");
  expect(removeAdminUser("tuan")).toBe(true);
  expect(await verifyAdmin("tuan", "new-password-9")).toBe(false);
});

test("admin server gates api behind login", async () => {
  await addAdminUser("boss", "top-secret-22");
  const server = startAdminServer(0);
  const base = `http://127.0.0.1:${server.port}`;
  try {
    // no cookie: api is closed, login page open
    expect((await fetch(`${base}/api/status`)).status).toBe(401);
    expect((await fetch(`${base}/login`)).status).toBe(200);
    expect((await fetch(`${base}/healthz`)).status).toBe(200);

    // wrong password -> 401 page, no cookie
    const bad = await fetch(`${base}/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "boss", password: "nope-nope-nope" }),
      redirect: "manual",
    });
    expect(bad.status).toBe(401);
    expect(bad.headers.get("set-cookie")).toBeNull();

    // right password -> 302 + session cookie
    const good = await fetch(`${base}/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "boss", password: "top-secret-22" }),
      redirect: "manual",
    });
    expect(good.status).toBe(302);
    const cookie = (good.headers.get("set-cookie") ?? "").split(";")[0]!;
    expect(cookie).toContain("ch_admin=");

    const authed = await fetch(`${base}/api/status`, { headers: { cookie } });
    expect(authed.status).toBe(200);
    expect((await authed.json()).version).toBeTruthy();

    // logout kills the session
    const out = await fetch(`${base}/logout`, { headers: { cookie }, redirect: "manual" });
    expect(out.status).toBe(302);
    expect((await fetch(`${base}/api/status`, { headers: { cookie } })).status).toBe(401);
  } finally {
    server.stop(true);
  }
});

test("session helpers", async () => {
  await addAdminUser("sess-user", "password-1234");
  const r = req("/login");
  const { createSession } = await import("../src/admin/auth.ts");
  const token = createSession("sess-user");
  const cookieHeader = sessionCookie(r, token);
  expect(cookieHeader).toContain("HttpOnly");
  expect(cookieHeader).not.toContain("Secure");

  const authed = req("/api/status", { headers: { cookie: `ch_admin=${token}` } });
  expect(sessionUser(authed)).toBe("sess-user");
  expect(sessionUser(req("/api/status"))).toBeNull();
  expect(sessionUser(req("/api/status", { headers: { cookie: "ch_admin=zz" } }))).toBeNull();

  // session dies with the user
  removeAdminUser("sess-user");
  expect(sessionUser(authed)).toBeNull();
});
