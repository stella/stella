import type * as React from "react";

import { clsx } from "clsx";
import type { ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Compose multiple refs into a single ref callback.
 * Adapted from `@radix-ui/react-compose-refs` (MIT).
 *
 * Collects cleanup functions returned by React 19 ref
 * callbacks and returns a combined cleanup so React can
 * invoke it on unmount instead of re-calling with `null`.
 *
 * Use this rather than merging refs inline: forwarding a
 * caller's return value verbatim makes React read whatever
 * their callback happened to return as a cleanup, and warn
 * when it is neither a function nor `undefined`.
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
            cleanup();
          });
        } else if (node !== null) {
          cleanups.push(() => {
            ref(null);
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
