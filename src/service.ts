/**
 * Windows background service via Task Scheduler (same mechanism as opencodex):
 * Task (logon/unlock trigger) -> wscript hidden .vbs -> .cmd restart loop -> bun src/cli.ts start.
 */
import { existsSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { HOME, LOG_PATH, ensureHome } from "./paths.ts";

export const TASK_NAME = "ch-relay-agent";
const ROOT = resolve(import.meta.dir, "..");
const CMD_PATH = join(HOME, "ch-relay-service.cmd");
const VBS_PATH = join(HOME, "ch-relay-service.vbs");
const XML_PATH = join(HOME, "ch-relay-task.xml");

function xmlEscape(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

async function run(cmd: string[]): Promise<{ code: number; out: string }> {
  const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const out = (await new Response(p.stdout).text()) + (await new Response(p.stderr).text());
  return { code: await p.exited, out: out.trim() };
}

const SYS32 = join(process.env.SystemRoot ?? "C:\\Windows", "System32");

async function currentUserSid(): Promise<string> {
  const r = await run([join(SYS32, "whoami.exe"), "/user", "/fo", "csv", "/nh"]);
  const sid = r.out.split(",").pop()?.replace(/"/g, "").trim();
  if (!sid?.startsWith("S-")) throw new Error(`cannot read user SID: ${r.out}`);
  return sid;
}

export async function installService(port: number): Promise<string> {
  if (process.platform !== "win32") throw new Error("service install is only implemented for Windows");
  ensureHome();
  const bun = process.execPath;
  // Compiled build: execPath is the app exe itself; dev mode: bun + cli.ts.
  const isExe = !/bun[^\\\/]*\.exe$/i.test(bun);
  const workDir = isExe ? dirname(bun) : ROOT;
  const runLine = isExe ? `"${bun}" start --port ${port}` : `"${bun}" "${join(ROOT, "src", "cli.ts")}" start --port ${port}`;
  writeFileSync(
    CMD_PATH,
    [
      "@echo off",
      "setlocal",
      `set CH_HOME=${HOME}`,
      `cd /d "${workDir}"`,
      ":loop",
      `echo [service] %DATE% %TIME% starting >> "${LOG_PATH}"`,
      `${runLine} >> "${LOG_PATH}" 2>&1`,
      "if %ERRORLEVEL%==0 goto end",
      `echo [service] exited %ERRORLEVEL%, restarting in 5s >> "${LOG_PATH}"`,
      "ping -n 6 127.0.0.1 >nul",
      "goto loop",
      ":end",
      "",
    ].join("\r\n"),
  );
  writeFileSync(VBS_PATH, `CreateObject("WScript.Shell").Run """${CMD_PATH}""", 0, True\r\n`);
  const sid = await currentUserSid();
  const xml = `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>ch-relay proxy for Codex</Description></RegistrationInfo>
  <Triggers>
    <LogonTrigger><Enabled>true</Enabled><UserId>${sid}</UserId></LogonTrigger>
    <SessionStateChangeTrigger><Enabled>true</Enabled><StateChange>SessionUnlock</StateChange><UserId>${sid}</UserId></SessionStateChangeTrigger>
  </Triggers>
  <Principals><Principal id="Author"><UserId>${sid}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RestartOnFailure><Interval>PT1M</Interval><Count>3</Count></RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec><Command>C:\\Windows\\System32\\wscript.exe</Command><Arguments>/b /nologo "${xmlEscape(VBS_PATH)}"</Arguments></Exec>
  </Actions>
</Task>`;
  // schtasks requires UTF-16 LE with BOM for this declaration.
  writeFileSync(XML_PATH, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(xml, "utf16le")]));
  const r = await run([join(SYS32, "schtasks.exe"), "/create", "/tn", TASK_NAME, "/xml", XML_PATH, "/f"]);
  if (r.code !== 0) throw new Error(`schtasks /create failed: ${r.out}`);
  const s = await run([join(SYS32, "schtasks.exe"), "/run", "/tn", TASK_NAME]);
  if (s.code !== 0) throw new Error(`schtasks /run failed: ${s.out}`);
  return `installed task ${TASK_NAME} (port ${port}); log: ${LOG_PATH}`;
}

export async function uninstallService(): Promise<string> {
  await run([join(SYS32, "schtasks.exe"), "/end", "/tn", TASK_NAME]);
  const r = await run([join(SYS32, "schtasks.exe"), "/delete", "/tn", TASK_NAME, "/f"]);
  return r.code === 0 ? `removed task ${TASK_NAME}` : `schtasks /delete: ${r.out}`;
}

export async function serviceStatus(): Promise<string> {
  const r = await run([join(SYS32, "schtasks.exe"), "/query", "/tn", TASK_NAME, "/fo", "list"]);
  return r.code === 0 ? r.out : existsSync(XML_PATH) ? "task files exist but task not registered" : "not installed";
}
