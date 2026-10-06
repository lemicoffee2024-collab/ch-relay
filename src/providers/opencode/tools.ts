// Responses tool declarations -> flat function tools (Chat Completions / Anthropic),
// plus the reverse mapping used when a model calls one of them.

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);

export interface ToolTarget {
  /** Name Codex knows the tool by (without namespace). */
  name: string;
  /** Codex namespace for MCP-style groups (omitted for the built-in `functions` group). */
  namespace?: string;
  /** Freeform custom tool: the model sees {input: string}, Codex expects custom_tool_call. */
  custom: boolean;
}

export interface FlatTool {
  wireName: string;
  description: string;
  parameters: Obj;
}

const EXEC_INPUT_DESCRIPTION =
  "JavaScript source for unified exec. Use await tools.exec_command(...) for shell commands and text(...) to return textual output; do not provide a bare shell command.";

/** Wire-safe function name (`^[A-Za-z0-9_-]{1,64}$`). */
function safeName(raw: string): string {
  let s = raw.replace(/[^A-Za-z0-9_-]/g, "_");
  if (!s) s = "tool";
  if (s.length > 64) {
    const h = new Bun.CryptoHasher("sha256").update(raw).digest("hex").slice(0, 8);
    s = `${s.slice(0, 55)}_${h}`;
  }
  return s;
}

export class ToolMap {
  readonly tools: FlatTool[] = [];
  private byWire = new Map<string, ToolTarget>();
  private toWire = new Map<string, string>();

  constructor(tools: unknown) {
    if (!Array.isArray(tools)) return;
    for (const t of tools) {
      if (!isObj(t)) continue;
      if (t.type === "function") this.addFunction(t, undefined);
      else if (t.type === "custom") this.addCustom(t, undefined);
      else if (t.type === "namespace" && Array.isArray(t.tools)) {
        const ns = typeof t.name === "string" && t.name !== "functions" ? t.name : undefined;
        for (const c of t.tools) {
          if (!isObj(c)) continue;
          if (c.type === "function") this.addFunction(c, ns);
          else if (c.type === "custom") this.addCustom(c, ns);
        }
      }
      // Hosted tools (web_search, image_generation, local_shell, tool_search, ...) cannot run
      // on a translated wire and are dropped.
    }
  }

  private key(name: string, namespace: string | undefined) {
    return namespace ? `${namespace}\u0000${name}` : name;
  }

  private register(target: ToolTarget): string | null {
    const k = this.key(target.name, target.namespace);
    if (this.toWire.has(k)) return null;
    let wire = safeName(target.namespace ? `${target.namespace}__${target.name}` : target.name);
    let n = 2;
    while (this.byWire.has(wire)) wire = safeName(`${wire.slice(0, 60)}_${n++}`);
    this.byWire.set(wire, target);
    this.toWire.set(k, wire);
    return wire;
  }

  private addFunction(t: Obj, namespace: string | undefined) {
    const f = isObj(t.function) ? t.function : t;
    if (typeof f.name !== "string" || !f.name) return;
    const wire = this.register({ name: f.name, namespace, custom: false });
    if (!wire) return;
    this.tools.push({
      wireName: wire,
      description: typeof f.description === "string" ? f.description : "",
      parameters: normalizeSchema(f.parameters),
    });
  }

  private addCustom(t: Obj, namespace: string | undefined) {
    if (typeof t.name !== "string" || !t.name) return;
    const wire = this.register({ name: t.name, namespace, custom: true });
    if (!wire) return;
    let description = typeof t.description === "string" ? t.description : "";
    const fmt = isObj(t.format) ? t.format : undefined;
    if (fmt && typeof fmt.definition === "string" && fmt.definition.length <= 4000) {
      description += `\n\nThe input must follow this ${String(fmt.syntax ?? "grammar")} grammar:\n${fmt.definition}`;
    }
    this.tools.push({
      wireName: wire,
      description,
      parameters: {
        type: "object",
        properties: {
          input: {
            type: "string",
            description: t.name === "exec" ? EXEC_INPUT_DESCRIPTION : "Raw input for this freeform tool.",
          },
        },
        required: ["input"],
      },
    });
  }

  /** Wire name for a historical call (registers an unknown tool so history stays consistent). */
  wireName(name: string, namespace?: string): string {
    const w = this.toWire.get(this.key(name, namespace));
    if (w) return w;
    return safeName(namespace ? `${namespace}__${name}` : name);
  }

  /** Resolve a model-emitted function name back to the Codex tool. */
  resolve(wire: string): ToolTarget {
    const hit = this.byWire.get(wire);
    if (hit) return hit;
    // Some models echo "<namespace>.<name>" instead of the flattened form.
    const dot = wire.indexOf(".");
    if (dot > 0) {
      const alt = this.byWire.get(safeName(`${wire.slice(0, dot)}__${wire.slice(dot + 1)}`));
      if (alt) return alt;
    }
    return { name: wire, custom: false };
  }

  get isEmpty(): boolean {
    return this.tools.length === 0;
  }
}

/** Function-call fields for the Responses item emitted to Codex. */
export function outputCallFields(target: ToolTarget, args: string): { extra: Obj; arguments: string } {
  if (target.custom) {
    let input = args;
    try {
      const parsed = JSON.parse(args || "{}");
      if (isObj(parsed) && typeof parsed.input === "string") input = parsed.input;
    } catch {
      // keep raw text as the freeform input
    }
    return { extra: { type: "custom_tool_call", name: target.name, input }, arguments: args };
  }
  const extra: Obj = { name: target.name };
  if (target.namespace) extra.namespace = target.namespace;
  return { extra, arguments: args };
}

// ---------------------------------------------------------------------------
// JSON schema normalization for Chat-style tool parameters
// ---------------------------------------------------------------------------

function normalizeNode(node: unknown, depth: number): unknown {
  if (depth > 32) return {};
  if (Array.isArray(node)) return node.map((n) => normalizeNode(n, depth + 1));
  if (!isObj(node)) return node;
  const out: Obj = {};
  for (const [k, v] of Object.entries(node)) {
    if (k === "$schema") continue;
    if (k === "properties" && isObj(v)) {
      const props: Obj = {};
      for (const [pk, pv] of Object.entries(v)) props[pk] = normalizeNode(pv, depth + 1);
      out.properties = props;
    } else if (k === "type" && Array.isArray(v)) {
      const nonNull = v.filter((x) => x !== "null");
      out.type = nonNull.length === 1 ? nonNull[0] : nonNull.length === 0 ? "string" : nonNull;
    } else if (k === "required" && Array.isArray(v)) {
      if (v.length) out.required = v;
    } else if (typeof v === "object" && v !== null) {
      out[k] = normalizeNode(v, depth + 1);
    } else {
      out[k] = v;
    }
  }
  return out;
}

/** Merge the object alternatives of a root-level oneOf/anyOf/allOf into one object schema. */
function flattenRootCombinators(schema: Obj): Obj {
  const out: Obj = { ...schema };
  for (const key of ["oneOf", "anyOf", "allOf"]) {
    const alts = out[key];
    if (!Array.isArray(alts)) continue;
    delete out[key];
    const props: Obj = { ...(isObj(out.properties) ? out.properties : {}) };
    let required: string[] | undefined = key === "allOf" ? [...((out.required as string[]) ?? [])] : undefined;
    for (const alt of alts) {
      if (!isObj(alt)) continue;
      if (isObj(alt.properties)) Object.assign(props, alt.properties);
      if (key === "allOf" && Array.isArray(alt.required)) required!.push(...(alt.required as string[]));
    }
    out.properties = props;
    if (required?.length) out.required = [...new Set(required)];
  }
  return out;
}

export function normalizeSchema(params: unknown): Obj {
  let s: Obj = isObj(params) ? { ...params } : {};
  s = flattenRootCombinators(s);
  s.type = "object";
  if (!isObj(s.properties)) s.properties = {};
  return normalizeNode(s, 0) as Obj;
}
