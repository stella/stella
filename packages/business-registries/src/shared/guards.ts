// Structural type guards shared across every registry adapter. Each
// adapter's client and parser previously hand-rolled an identical
// `isRecord`; single-homing it here keeps the "plain JSON object"
// predicate consistent (notably: arrays are NOT records).

/**
 * Narrow an unknown value to a plain object keyed by string. Arrays and
 * `null` are rejected so callers can safely index string keys.
 */
export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const hasOptionalString = (
  record: Record<string, unknown>,
  key: string,
): boolean => record[key] === undefined || typeof record[key] === "string";

export const hasOptionalNumber = (
  record: Record<string, unknown>,
  key: string,
): boolean => record[key] === undefined || typeof record[key] === "number";
