/**
 * Type-narrowing `.includes()` that avoids
 * `as readonly string[]` at every call site.
 */
// SAFETY: Widening the array element type is sound
// because `.includes()` only checks equality.
export const includesValue = <T extends string>(
  arr: readonly T[],
  value: string,
): value is T => arr.some((candidate) => candidate === value);

export const shuffleArray = <T>(originalArray: readonly T[]): T[] => {
  const array = [...originalArray];

  for (let i = array.length - 1; i > 0; i--) {
    const randomIndex = Math.floor(Math.random() * (i + 1));

    const a = array[i];
    const b = array[randomIndex];
    if (a === undefined || b === undefined) {
      continue;
    }
    array[randomIndex] = a;
    array[i] = b;
  }

  return array;
};
