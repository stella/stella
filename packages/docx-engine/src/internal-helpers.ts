/** Narrow `unknown` to a plain object (not null, not array). */
export const isDocxRecord = (
  value: unknown,
): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Narrow `unknown` to an array without Array.isArray's `any[]` widening. */
export const isDocxArray = (value: unknown): value is readonly unknown[] =>
  Array.isArray(value);

export function toDocxArray<T>(value: T[] | null | undefined): T[];
export function toDocxArray<T>(
  value: readonly T[] | null | undefined,
): readonly T[];
export function toDocxArray<T>(
  value: readonly T[] | null | undefined,
): readonly T[] {
  if (value === null || value === undefined) {
    return [];
  }
  return value;
}
