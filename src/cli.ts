#!/usr/bin/env bun
import { readFileSync, writeFileSync } from "node:fs";
import { DEFAULT_ADMIN_PORT, DEFAULT_PORT, DEFAULT_SHARE_PORT, PID_PATH, ensureHome } from "./paths.ts";
import { getDb, kvPurgeExpired } from "./store/db.ts";

function stopRunning() {
  try {
    const pid = Number(readFileSync(PID_PATH, "utf8"));
    if (pid && pid !== process.pid) process.kill(pid);
    console.log(`stopped pid ${pid}`);
  } catch {
    console.log("no running instance");
  }
}

const [cmd = "start", ...args] = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

async function main() {
  ensureHome();
  getDb();
  switch (cmd) {
    case "start": {
      const port = Number(flag("port") ?? DEFAULT_PORT);
      if (port > 0) {
        const { startServer } = await import("./server.ts");
        startServer(port);
      }
      const sharePort = Number(flag("share-port") ?? DEFAULT_SHARE_PORT);
      if (sharePort > 0) {
        const { startShareServer } = await import("./share/server.ts");
        startShareServer(sharePort);
      }
      const adminPort = Number(flag("admin-port") ?? DEFAULT_ADMIN_PORT);
      if (adminPort > 0) {
        try {
          const { startAdminServer } = await import("./admin/server.ts");
          startAdminServer(adminPort, "127.0.0.1", { mainPort: port > 0 ? port : DEFAULT_PORT });
        } catch (err) {
          console.error(`[ch-relay] admin console failed on :${adminPort}`, err);
        }
      }
      writeFileSync(PID_PATH, String(process.pid));
      setInterval(kvPurgeExpired, 10 * 60_000).unref();
      const { purgeExpiredShareUsers } = await import("./share/users.ts");
      const sweep = () => {
        const gone = purgeExpiredShareUsers();
        if (gone.length) console.log(`[ch-relay] ${new Date().toISOString()} INFO share users expired: ${gone.join(", ")}`);
      };
      sweep();
      setInterval(sweep, 60_000).unref();
      const { purgeShareEvents } = await import("./share/telemetry.ts");
      const purgeEvents = () => {
        try {
          purgeShareEvents();
        } catch (err) {
          console.error("[ch-relay] share event purge failed", err);
        }
      };
      purgeEvents();
      setInterval(purgeEvents, 6 * 3600_000).unref();
      // WHAM /usage poll: the response-header readings only move in coarse
      // jumps — the endpoint reports finer percent, giving the real
      // quota-per-request series in quota_samples. CH_QUOTA_POLL_MS=0 disables.
      const quotaPollMs = Number(process.env.CH_QUOTA_POLL_MS ?? 120_000);
      if (quotaPollMs > 0) {
        const poll = async () => {
          try {
            const { listAccounts, getQuota } = await import("./store/accounts.ts");
            const { chatgptProvider } = await import("./providers/chatgpt/index.ts");
            const { recordQuotaSample, purgeQuotaSamples } = await import("./share/telemetry.ts");
            for (const acc of listAccounts("chatgpt")) {
              if (!acc.enabled || !chatgptProvider.refreshQuota) continue;
              try {
                await chatgptProvider.refreshQuota(acc);
                const q = getQuota(acc.id);
                if (q) recordQuotaSample(String(q.email ?? acc.email ?? acc.id), q as Parameters<typeof recordQuotaSample>[1], "wham");
              } catch (err) {
                console.error(`[ch-relay] wham poll ${acc.email ?? acc.id}:`, err instanceof Error ? err.message : err);
              }
            }
            purgeQuotaSamples();
          } catch {
            /* poller must never crash the agent */
          }
        };
        void poll();
        setInterval(() => void poll(), quotaPollMs).unref();
      }
      (await import("./stats/client.ts")).warmStats();
      break;
    }
    case "import": {
      const { importFromOpencodex } = await import("./import-opencodex.ts");
      console.log(await importFromOpencodex());
      break;
    }
    case "sync": {
      const { syncCodex } = await import("./codex-sync.ts");
      console.log(await syncCodex(Number(flag("port") ?? DEFAULT_PORT)));
      break;
    }
    case "unsync": {
      const { unsyncCodex } = await import("./codex-sync.ts");
      console.log({ ok: unsyncCodex() });
      break;
    }
    case "service": {
      const svc = await import("./service.ts");
      const sub = args[0];
      if (sub === "install") console.log(await svc.installService(Number(flag("port") ?? DEFAULT_PORT)));
      else if (sub === "uninstall") {
        console.log(await svc.uninstallService());
        stopRunning();
      } else if (sub === "restart") {
        stopRunning(); // the .cmd loop restarts it
        console.log("restarting");
      } else console.log(await svc.serviceStatus());
      break;
    }
    case "allow": {
      const users = await import("./share/users.ts");
      const hoursAt = args.indexOf("--hours");
      const hours = hoursAt >= 0 ? Number(args[hoursAt + 1]) : null;
      const rest = hoursAt >= 0 ? [...args.slice(0, hoursAt), ...args.slice(hoursAt + 2)] : args;
      const [sub, email, ...label] = rest;
      if (sub === "add" && email) console.log(users.addShareUser(email, label.join(" ") || null, hours));
      else if (sub === "expire" && email && label[0]) console.log({ ok: users.setShareUserExpiry(email, label[0] === "off" ? null : Number(label[0])) });
      else if (sub === "remove" && email) console.log({ removed: users.removeShareUser(email) });
      else if (sub === "disable" && email) console.log({ ok: users.setShareUserEnabled(email, false) });
      else if (sub === "enable" && email) console.log({ ok: users.setShareUserEnabled(email, true) });
      else if (sub === "list" || !sub) console.table(users.listShareUsers());
      else {
        console.log("usage: ch-relay allow [list|add <email> [label] [--hours N]|expire <email> <hours|off>|remove <email>|enable <email>|disable <email>]");
        process.exit(1);
      }
      break;
    }
    case "admin": {
      const a = await import("./admin/auth.ts");
      const passAt = args.indexOf("--pass");
      const pass = passAt >= 0 ? args[passAt + 1] : undefined;
      const rest = passAt >= 0 ? [...args.slice(0, passAt), ...args.slice(passAt + 2)] : args;
      const [sub, user, ...label] = rest;
      const genPass = () => {
        const abc = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789";
        const b = new Uint8Array(16);
        crypto.getRandomValues(b);
        return [...b].map((x) => abc[x % abc.length]).join("");
      };
      if (sub === "add" && user) {
        const p = pass ?? genPass();
        console.log(await a.addAdminUser(user, p, label.join(" ") || null));
        if (!pass) console.log(`password (lưu lại, chỉ hiện 1 lần): ${p}`);
      } else if (sub === "remove" && user) console.log({ removed: a.removeAdminUser(user) });
      else if (sub === "passwd" && user) {
        const p = pass ?? genPass();
        console.log({ ok: await a.setAdminPassword(user, p) });
        if (!pass) console.log(`password (lưu lại, chỉ hiện 1 lần): ${p}`);
      } else if (sub === "list" || !sub) console.table(a.listAdminUsers());
      else {
        console.log("usage: ch-relay admin [list|add <user> [label] [--pass P]|remove <user>|passwd <user> [--pass P]]");
        process.exit(1);
      }
      break;
    }
    case "stop":
      stopRunning();
      break;
    default:
      console.log("usage: ch-relay [start|stop|import|sync|unsync|allow|admin|service install|uninstall|restart|status] [--port N] [--share-port N] [--admin-port N]");
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
