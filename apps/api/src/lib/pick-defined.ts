/**
 * Picks only the defined (non-undefined) values for the given
 * keys from an object. Used in PATCH-style update handlers to
 * build a typed partial update object without the
 * `Record<string, unknown>` escape hatch.
 *
 * This also prevents leaking extra body fields (e.g. `queryKey`
 * injected by the `invalidateQuery` macro) into Drizzle's
 * `.set()` clause.
 */
export const pickDefined = <
  T extends Record<string, unknown>,
  K extends keyof T,
>(
  obj: T,
  keys: readonly K[],
): Partial<Pick<T, K>> => {
  const result: Partial<Pick<T, K>> = {};
  for (const key of keys) {
    if (obj[key] !== undefined) {
      result[key] = obj[key];
    }
  }
  return result;
};
