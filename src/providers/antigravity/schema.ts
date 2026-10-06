// Tool name encoding and JSON-schema sanitization for Gemini function declarations.
import { createHash } from "node:crypto";

type Schema = Record<string, unknown>;

const TOOL_NAME_RE = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;
const ALLOWED_TYPES = new Set(["string", "integer", "number", "boolean", "array", "object"]);
const MAX_DEPTH = 24;
const MAX_REF_DEPTH = 16;

/** Bidirectional mapping between client tool names and Gemini-safe wire names. */
export class ToolNameCodec {
  private toWireMap = new Map<string, string>();
  private fromWireMap = new Map<string, string>();

  toWire(name: string): string {
    const hit = this.toWireMap.get(name);
    if (hit) return hit;
    let wire = name;
    if (!TOOL_NAME_RE.test(name) || this.fromWireMap.has(name)) {
      let cleaned = name.replace(/[^A-Za-z0-9_-]/g, "_");
      if (!/^[A-Za-z_]/.test(cleaned)) cleaned = `_${cleaned}`;
      const prefix = (cleaned || "tool").slice(0, 55);
      for (let salt = 0; ; salt++) {
        const sha = createHash("sha256").update(salt === 0 ? name : `${name}#${salt}`).digest("hex").slice(0, 8);
        wire = `${prefix}_${sha}`;
        if (!this.fromWireMap.has(wire)) break;
      }
    }
    this.toWireMap.set(name, wire);
    this.fromWireMap.set(wire, name);
    return wire;
  }

  fromWire(wire: string): string {
    return this.fromWireMap.get(wire) ?? wire;
  }
}

function isRecord(v: unknown): v is Schema {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function collectDefs(root: unknown): Map<string, unknown> {
  const defs = new Map<string, unknown>();
  if (!isRecord(root)) return defs;
  for (const bag of ["$defs", "definitions"]) {
    const b = root[bag];
    if (!isRecord(b)) continue;
    for (const [k, v] of Object.entries(b)) defs.set(`#/${bag}/${k}`, v);
  }
  return defs;
}

function stringEnum(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const vals = [...new Set(v.filter((x): x is string => typeof x === "string"))];
  return vals.length ? vals : undefined;
}

function sanitizeNode(node: unknown, defs: Map<string, unknown>, depth: number, refDepth: number, active: Set<string>): Schema {
  if (depth >= MAX_DEPTH || !isRecord(node)) return {};

  if (typeof node.$ref === "string") {
    const ref = node.$ref;
    const target = defs.get(ref);
    if (!isRecord(target) || refDepth >= MAX_REF_DEPTH || active.has(ref)) return {};
    active.add(ref);
    try {
      const { $ref: _r, ...siblings } = node;
      return sanitizeNode({ ...target, ...siblings }, defs, depth, refDepth + 1, active);
    } finally {
      active.delete(ref);
    }
  }

  // allOf: merge simple object members (properties/required) — the rest is dropped.
  if (Array.isArray(node.allOf)) {
    const merged: Schema = { ...node };
    delete merged.allOf;
    for (const member of node.allOf) {
      const m = isRecord(member) && typeof member.$ref === "string" ? defs.get(member.$ref) : member;
      if (!isRecord(m)) continue;
      if (isRecord(m.properties)) merged.properties = { ...(isRecord(merged.properties) ? merged.properties : {}), ...m.properties };
      if (Array.isArray(m.required)) merged.required = [...(Array.isArray(merged.required) ? merged.required : []), ...m.required];
      if (merged.type === undefined && m.type !== undefined) merged.type = m.type;
      if (merged.description === undefined && typeof m.description === "string") merged.description = m.description;
    }
    return sanitizeNode(merged, defs, depth, refDepth, active);
  }

  const out: Schema = {};
  const types = Array.isArray(node.type) ? node.type : node.type === undefined ? [] : [node.type];
  let nullable = false;
  for (const t of types) {
    if (typeof t !== "string") continue;
    const lt = t.toLowerCase();
    if (lt === "null") nullable = true;
    else if (ALLOWED_TYPES.has(lt) && out.type === undefined) out.type = lt;
  }
  if (nullable && out.type !== undefined) out.nullable = true;
  if (typeof node.nullable === "boolean") out.nullable = node.nullable;
  if (typeof node.description === "string") out.description = node.description;
  if (typeof node.format === "string") out.format = node.format;

  const en = stringEnum(node.enum ?? (typeof node.const === "string" ? [node.const] : undefined));
  if (en) {
    out.enum = en;
    if (out.type === undefined) out.type = "string";
  }

  if (isRecord(node.properties)) {
    const props: Schema = {};
    for (const [k, v] of Object.entries(node.properties)) props[k] = sanitizeNode(v, defs, depth + 1, refDepth, active);
    out.properties = props;
    if (out.type === undefined) out.type = "object";
    if (Array.isArray(node.required)) {
      const req = [...new Set(node.required.filter((r): r is string => typeof r === "string" && Object.hasOwn(props, r)))];
      if (req.length) out.required = req;
    }
  }

  if (isRecord(node.items)) {
    out.items = sanitizeNode(node.items, defs, depth + 1, refDepth, active);
    if (out.type === undefined) out.type = "array";
  } else if (Array.isArray(node.items) && node.items.length) {
    out.items = sanitizeNode(node.items[0], defs, depth + 1, refDepth, active);
  }
  if (out.type === "array" && out.items === undefined) out.items = {};

  const union = Array.isArray(node.anyOf) ? node.anyOf : Array.isArray(node.oneOf) ? node.oneOf : undefined;
  if (union && union.length) {
    const members = union.map((m) => sanitizeNode(m, defs, depth + 1, refDepth, active));
    const isNullMember = (i: number) => isRecord(union[i]) && (union[i] as Schema).type === "null";
    const rawNull = union.filter((_m, i) => isNullMember(i)).length;
    const nonNull = members.filter((m, i) => !isNullMember(i) && Object.keys(m).length > 0);
    if (nonNull.length === 1) {
      Object.assign(out, { ...nonNull[0], ...(out.description ? { description: out.description } : {}) });
      if (rawNull) out.nullable = true;
    } else if (nonNull.length > 1) {
      // Same-type enum members collapse into one enum; other unions are widened (dropped),
      // matching opencodex: CCA rejects many union shapes.
      const t = nonNull[0]!.type;
      if (nonNull.every((m) => m.type === t && Array.isArray(m.enum))) {
        out.type = t;
        out.enum = [...new Set(nonNull.flatMap((m) => m.enum as string[]))];
      }
      if (rawNull && out.type) out.nullable = true;
    }
  }
  return out;
}

/**
 * Reduce a JSON schema to the Gemini function-declaration subset: drops allOf/oneOf/not,
 * pattern, additionalProperties, patternProperties, unevaluated*, if/then/else, $schema etc.,
 * dereferences local $ref and caps depth at 24. Root is always an object schema.
 */
export function sanitizeToolSchema(parameters: unknown): Schema {
  try {
    const root = sanitizeNode(parameters, collectDefs(parameters), 0, 0, new Set());
    root.type = "object";
    delete root.nullable;
    delete root.anyOf;
    if (!isRecord(root.properties)) root.properties = {};
    return root;
  } catch {
    return { type: "object", properties: {} };
  }
}
