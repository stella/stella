/** Narrow `unknown` to a plain object (not null, not array). */
export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Narrow `unknown` to an array without Array.isArray's `any[]` widening. */
export const isUnknownArray = (value: unknown): value is readonly unknown[] =>
  Array.isArray(value);

export function arrayOrEmpty<T>(value: T[] | null | undefined): T[];
export function arrayOrEmpty<T>(
  value: readonly T[] | null | undefined,
): readonly T[];
export function arrayOrEmpty<T>(
  value: readonly T[] | null | undefined,
): readonly T[] {
  if (value === null || value === undefined) {
    return [];
  }
  return value;
}
