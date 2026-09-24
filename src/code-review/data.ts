import type { PlanningDependencies } from "./types.js";

/** JSON-only inputs: no accessors, class instances, cycles, prototype keys or non-finite numbers. */
export function canonical(value: unknown): string {
  const seen = new Set<object>();
  const visit = (v: unknown): string => {
    if (v === null || typeof v === "boolean" || typeof v === "string") return JSON.stringify(v);
    if (typeof v === "number" && Number.isFinite(v)) return JSON.stringify(v);
    if (typeof v !== "object" || v === null) throw Error("Expected finite JSON data");
    if (seen.has(v)) throw Error("Cyclic JSON data");
    seen.add(v);
    let out: string;
    if (Array.isArray(v)) {
      if (Object.keys(v).length !== v.length) throw Error("Sparse or decorated array");
      out = `[${Array.from({ length: v.length }, (_, i) => {
        const d = Object.getOwnPropertyDescriptor(v, String(i));
        if (!d || !("value" in d)) throw Error("Accessor in JSON data");
        return visit(d.value);
      }).join(",")}]`;
    } else {
      const proto = Object.getPrototypeOf(v);
      if (proto !== Object.prototype && proto !== null) throw Error("Non-plain JSON object");
      if (Object.getOwnPropertySymbols(v).length) throw Error("Symbol in JSON data");
      out = `{${Object.keys(v).sort().map((k) => {
        if (["__proto__", "prototype", "constructor"].includes(k)) throw Error("Reserved JSON key");
        const d = Object.getOwnPropertyDescriptor(v, k);
        if (!d || !("value" in d)) throw Error("Accessor in JSON data");
        return `${JSON.stringify(k)}:${visit(d.value)}`;
      }).join(",")}}`;
    }
    seen.delete(v);
    return out;
  };
  return visit(value);
}
export function clone<T>(value: T): T { return JSON.parse(canonical(value)) as T; }
export function freeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const v of Object.values(value)) freeze(v);
    Object.freeze(value);
  }
  return value;
}
export function digest(value: unknown, sha256: PlanningDependencies["sha256"]): string {
  const result = sha256(canonical(value));
  if (!/^[a-f0-9]{64}$/.test(result)) throw Error("SHA-256 must return 64 lowercase hex characters");
  return result;
}
export function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error(`${label}: expected object`);
  const p = Object.getPrototypeOf(value);
  if (p !== Object.prototype && p !== null) throw Error(`${label}: expected plain object`);
  return value as Record<string, unknown>;
}
export function keys(value: unknown, required: readonly string[], label: string): Record<string, unknown> {
  const r = record(value, label);
  if (Object.keys(r).length !== required.length || required.some(k => !Object.hasOwn(r, k)))
    throw Error(`${label}: unexpected or missing keys`);
  return r;
}
export function text(value: unknown, label: string, allowEmpty = false): asserts value is string {
  if (typeof value !== "string" || (!allowEmpty && !value.trim())) throw Error(`${label}: expected text`);
}
export function id(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !/^[A-Za-z][A-Za-z0-9_-]{0,95}$/.test(value)
      || ["__proto__", "prototype", "constructor", "none", "insufficient_context", "outside_packet"].includes(value))
    throw Error(`${label}: invalid id`);
}
export function integer(value: unknown, min: number, max: number, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max)
    throw Error(`${label}: integer outside [${min}, ${max}]`);
}
export function probability(value: unknown, label: string): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1)
    throw Error(`${label}: invalid probability`);
}
export function list(value: unknown, label: string): asserts value is unknown[] {
  if (!Array.isArray(value)) throw Error(`${label}: expected array`);
}
export function unique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) throw Error(`${label}: duplicate id`);
}
export function oneOf<T extends string>(value: unknown, options: readonly T[], label: string): asserts value is T {
  if (!options.includes(value as T)) throw Error(`${label}: unknown value`);
}
export function tokenCount(textValue: string, deps: PlanningDependencies): number {
  const n = deps.countTokens(textValue);
  integer(n, 0, Number.MAX_SAFE_INTEGER, "token count");
  return n;
}
