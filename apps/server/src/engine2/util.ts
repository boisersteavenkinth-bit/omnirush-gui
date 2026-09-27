/** Small readers shared by the engine 2.x dialect adapter (engine2/*). */

export type JsonRecord = Record<string, unknown>;

export function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function record(value: unknown, key: string): JsonRecord | undefined {
  if (!isRecord(value)) return undefined;
  const nested = value[key];
  return isRecord(nested) ? nested : undefined;
}

export function str(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) return undefined;
  const field = value[key];
  return typeof field === "string" ? field : undefined;
}

export function num(value: unknown, key: string): number | undefined {
  if (!isRecord(value)) return undefined;
  const field = value[key];
  return typeof field === "number" && Number.isFinite(field) ? field : undefined;
}

export function bool(value: unknown, key: string): boolean | undefined {
  if (!isRecord(value)) return undefined;
  const field = value[key];
  return typeof field === "boolean" ? field : undefined;
}

export function arr(value: unknown, key: string): unknown[] {
  if (!isRecord(value)) return [];
  const field = value[key];
  return Array.isArray(field) ? field : [];
}

/** A 2.x response body: `{data}` / `{location, data}` wrappers are unwrapped. */
export function unwrap(value: unknown): unknown {
  return isRecord(value) && "data" in value ? value.data : value;
}

export function omitUndefined<T extends JsonRecord>(value: T): T {
  for (const key of Object.keys(value)) if (value[key] === undefined) delete value[key];
  return value;
}
