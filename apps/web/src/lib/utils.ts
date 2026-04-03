/**
 * Strip entries whose value is `undefined` so the result
 * satisfies `exactOptionalPropertyTypes`. Eden-generated
 * query types use `prop?: T` (without `| undefined`); this
 * helper bridges our types (which include `| undefined`)
 * to Eden's stricter shape.
 *
 * At runtime, keys with `undefined` values are deleted so
 * the object is structurally identical to one where those
 * keys were never set.
 */
// SAFETY: the mapped type below mirrors the input but
// strips `| undefined` from each value. At runtime every
// undefined-valued key is physically removed, so the cast
// is sound. This is the canonical boundary between our
// internal types (`prop?: T | undefined`) and Eden's
// inferred types (`prop?: T`).
export const stripUndefined = <T extends Record<string, unknown>>(
  obj: T,
): {
  [K in keyof T]: Exclude<T[K], undefined>;
} => {
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(obj)) {
    if (obj[key] !== undefined) {
      result[key] = obj[key];
    }
  }
  // SAFETY: result mirrors input with undefined-valued keys
  // removed; the mapped return type reflects this invariant.
  // eslint-disable-next-line typescript/consistent-type-assertions, typescript/no-unsafe-type-assertion
  return result as { [K in keyof T]: Exclude<T[K], undefined> };
};

/**
 * Type-narrowing `.includes()` that avoids
 * `as readonly string[]` at every call site.
 */
// SAFETY: Widening the array element type is sound
// because `.includes()` only checks equality.
export const includesValue = <T extends string>(
  arr: readonly T[],
  value: string,
): value is T =>
  // eslint-disable-next-line typescript/consistent-type-assertions, typescript/no-unsafe-type-assertion
  (arr as readonly string[]).includes(value);

export const shuffleArray = <T>(originalArray: T[]): T[] => {
  const array = [...originalArray];

  for (let i = array.length - 1; i > 0; i--) {
    const randomIndex = Math.floor(Math.random() * (i + 1));

    // SAFETY: i is in [1, array.length-1] and randomIndex
    // is in [0, i]; both always in bounds.
    // eslint-disable-next-line typescript/consistent-type-assertions, typescript/no-unsafe-type-assertion
    const a = array[i] as T;
    // eslint-disable-next-line typescript/consistent-type-assertions, typescript/no-unsafe-type-assertion
    const b = array[randomIndex] as T;
    array[randomIndex] = a;
    array[i] = b;
  }

  return array;
};
