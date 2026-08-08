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

export const downloadFile = (blob: Blob, fileName: string) => {
  const url = URL.createObjectURL(blob);

  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;

  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
};

/**
 * Force a synchronous style and layout flush so pending DOM writes (a class
 * change, an injected style) take effect before the next mutation. Reading a
 * layout property is the side effect; the returned value is intentionally
 * discarded.
 */
export const forceReflow = (element: HTMLElement): void => {
  element.getBoundingClientRect();
};
