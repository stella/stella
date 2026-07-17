import type * as React from "react";

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

/**
 * Compose multiple refs into a single ref callback.
 * Adapted from `@radix-ui/react-compose-refs` (MIT).
 *
 * Collects cleanup functions returned by React 19 ref
 * callbacks and returns a combined cleanup so React can
 * invoke it on unmount instead of re-calling with `null`.
 */
export const composeRefs =
  <T>(
    ...refs: (React.Ref<T> | undefined)[]
  ): ((node: T | null) => (() => void) | undefined) =>
  (node) => {
    const cleanups: (() => void)[] = [];
    for (const ref of refs) {
      if (typeof ref === "function") {
        const cleanup = ref(node);
        if (typeof cleanup === "function") {
          cleanups.push(() => {
            void cleanup();
          });
        } else if (node !== null) {
          cleanups.push(() => {
            void ref(null);
          });
        }
      } else if (ref !== undefined && ref !== null) {
        ref.current = node;
        if (node !== null) {
          cleanups.push(() => {
            ref.current = null;
          });
        }
      }
    }
    if (cleanups.length > 0) {
      return () => {
        for (const cleanup of cleanups) {
          cleanup();
        }
      };
    }
    return undefined;
  };

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
