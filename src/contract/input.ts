/** Read plain data properties without invoking accessors. Not a plugin sandbox. */
export function dataRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  const out: Record<string, unknown> = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") return null;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor)) return null;
    out[key] = descriptor.value;
  }
  return out;
}

/** A success requires a real boolean and an empty, well-formed error list. */
export function validationFailure(value: unknown): string | null {
  const validation = dataRecord(value);
  if (!validation || typeof validation.ok !== "boolean" || !Array.isArray(validation.errors))
    return "Validation failed: malformed validation result.";
  const errors: unknown[] = Array.from(validation.errors);
  if (!errors.every((error): error is string => typeof error === "string"))
    return "Validation failed: malformed validation errors.";
  if (!validation.ok || errors.length > 0)
    return `Validation failed: ${errors.join("; ") || "validator did not succeed"}`;
  return null;
}
