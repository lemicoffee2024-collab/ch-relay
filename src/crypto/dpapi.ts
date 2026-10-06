/**
 * Windows DPAPI (CryptProtectData) via bun:ffi — data encrypted at rest can only
 * be decrypted by this user account on this machine. Non-Windows builds fall back
 * to passthrough so tests still run elsewhere.
 */
import { dlopen, FFIType, ptr, toArrayBuffer } from "bun:ffi";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

export const ENC_PREFIX = "dpapi1:";
const isWin = process.platform === "win32";

// DATA_BLOB on x64: DWORD cbData + 4 pad + BYTE* pbData = 16 bytes.
const BLOB_BYTES = 16;
const CRYPTPROTECT_UI_FORBIDDEN = 0x1;

type Crypt32 = {
  CryptProtectData: (pIn: number, d: number, e: number, r: number, p: number, f: number, pOut: number) => number;
  CryptUnprotectData: (pIn: number, d: number, e: number, r: number, p: number, f: number, pOut: number) => number;
};
type Kernel32 = { LocalFree: (h: number) => number };

let crypt32: Crypt32 | null = null;
let kernel32: Kernel32 | null = null;

function load(): boolean {
  if (!isWin) return false;
  if (crypt32) return true;
  const blobSig = {
    args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.ptr],
    returns: FFIType.i32,
  } as const;
  crypt32 = dlopen("crypt32.dll", { CryptProtectData: blobSig, CryptUnprotectData: blobSig }).symbols as unknown as Crypt32;
  kernel32 = dlopen("kernel32.dll", { LocalFree: { args: [FFIType.ptr], returns: FFIType.ptr } }).symbols as unknown as Kernel32;
  return true;
}

function toBlob(data: Uint8Array): Uint8Array {
  const b = new Uint8Array(BLOB_BYTES);
  const dv = new DataView(b.buffer);
  dv.setUint32(0, data.byteLength, true);
  dv.setBigUint64(8, BigInt(ptr(data)), true);
  return b;
}

function readBlob(blob: Uint8Array): { len: number; p: bigint } {
  const dv = new DataView(blob.buffer, blob.byteOffset);
  return { len: dv.getUint32(0, true), p: dv.getBigUint64(8, true) };
}

function cryptCall(fn: "CryptProtectData" | "CryptUnprotectData", input: Uint8Array): Uint8Array {
  if (!load() || !crypt32 || !kernel32) throw new Error("dpapi unavailable");
  const inBlob = toBlob(input);
  const outBlob = new Uint8Array(BLOB_BYTES);
  const ok = crypt32[fn](ptr(inBlob), 0, 0, 0, 0, CRYPTPROTECT_UI_FORBIDDEN, ptr(outBlob));
  if (!ok) throw new Error(`${fn} failed`);
  const { len, p } = readBlob(outBlob);
  // toArrayBuffer returns a view over the LocalAlloc'd memory — copy before freeing.
  const out = new Uint8Array(toArrayBuffer(Number(p), 0, len)).slice();
  kernel32.LocalFree(Number(p));
  return out;
}

export function protectBytes(data: Uint8Array): Uint8Array {
  if (!load()) return data;
  return cryptCall("CryptProtectData", data);
}

export function unprotectBytes(data: Uint8Array): Uint8Array {
  if (!load()) return data;
  return cryptCall("CryptUnprotectData", data);
}

// Non-Windows: AES-256-GCM with a root-only key file (CH_KEY_FILE).
// Without that env var, non-Windows stays passthrough so tests still run.
export const AES_PREFIX = "aes1:";
let aesKey: Buffer | null = null;

function keyFile(): string | undefined {
  return isWin ? undefined : process.env.CH_KEY_FILE;
}

function getAesKey(): Buffer {
  if (aesKey) return aesKey;
  const path = keyFile();
  if (!path) throw new Error("CH_KEY_FILE not set");
  if (!existsSync(path)) writeFileSync(path, randomBytes(32).toString("base64"), { mode: 0o600 });
  const k = Buffer.from(readFileSync(path, "utf8").trim(), "base64");
  if (k.length !== 32) throw new Error(`bad key length in ${path}`);
  aesKey = k;
  return k;
}

function aesEncrypt(s: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", getAesKey(), iv);
  const ct = Buffer.concat([c.update(s, "utf8"), c.final()]);
  return AES_PREFIX + Buffer.concat([iv, c.getAuthTag(), ct]).toString("base64url");
}

function aesDecrypt(s: string): string {
  const raw = Buffer.from(s.slice(AES_PREFIX.length), "base64url");
  const d = createDecipheriv("aes-256-gcm", getAesKey(), raw.subarray(0, 12));
  d.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString("utf8");
}

export function isEncrypted(s: string): boolean {
  return s.startsWith(ENC_PREFIX) || s.startsWith(AES_PREFIX);
}

export function protectText(s: string): string {
  if (keyFile()) return aesEncrypt(s);
  if (!load()) return s;
  return ENC_PREFIX + Buffer.from(protectBytes(new TextEncoder().encode(s))).toString("base64url");
}

/** Decrypts `dpapi1:` / `aes1:` values; returns anything else unchanged (legacy plaintext). */
export function unprotectText(s: string): string {
  if (s.startsWith(AES_PREFIX)) return aesDecrypt(s);
  if (!s.startsWith(ENC_PREFIX)) return s;
  return new TextDecoder().decode(unprotectBytes(Buffer.from(s.slice(ENC_PREFIX.length), "base64url")));
}
