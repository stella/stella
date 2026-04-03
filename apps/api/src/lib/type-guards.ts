/** Narrow `unknown` to a plain object (not null, not array). */
export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Type-narrowing `includes()` for readonly const arrays.
 * Avoids `as readonly string[]` widening at every call site.
 */
export const includes = <T extends string>(
  arr: readonly T[],
  value: string,
): value is T => arr.some((item) => item === value);
