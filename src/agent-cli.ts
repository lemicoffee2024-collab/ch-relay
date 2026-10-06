#!/usr/bin/env bun
/**
 * ch-relay agent — packaged share endpoint for end-user machines.
 *
 *   ch-agent.exe start [--port 11500]
 */
import { writeFileSync } from "node:fs";
import { DEFAULT_SHARE_PORT, PID_PATH, ensureHome } from "./paths.ts";
import { getDb } from "./store/db.ts";
import { log } from "./lib/log.ts";

const [cmd = "start", ...args] = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

async function main() {
  switch (cmd) {
    case "start": {
      ensureHome();
      getDb();
      const sharePort = Number(flag("port") ?? DEFAULT_SHARE_PORT);
      const { startShareServer } = await import("./share/server.ts");
      startShareServer(sharePort);
      writeFileSync(PID_PATH, String(process.pid));
      log.info(`ch-relay agent listening on 127.0.0.1:${sharePort}`);
      break;
    }
    case "version":
      console.log("ch-relay agent");
      break;
    default:
      console.log("usage: ch-agent start [--port N]");
  }
}

await main();
