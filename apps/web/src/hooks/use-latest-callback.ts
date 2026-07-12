import { useCallback, useRef } from "react";

import { useExternalSyncEffect } from "@/hooks/use-effect";

/**
 * Returns a referentially stable function that always invokes the latest
 * `fn`. Use it to hand "read/act on the latest committed state" callbacks
 * to systems that live outside React's render and effect lifecycle: query
 * context objects, imperative editor/runtime bridges, external event
 * emitters, and listeners registered inside `useExternalSyncEffect`.
 *
 * This replaces `useEffectEvent` in apps/web. React reserves effect
 * events for calls made directly inside raw `useEffect` bodies of the
 * same component; raw `useEffect` is banned here (see
 * `@/hooks/use-effect`), so every `useEffectEvent` consumer in this app
 * violated that contract (`react-hooks/rules-of-hooks` enforces it since
 * oxlint 1.73). The semantics of the two are equivalent for our uses:
 * stable identity, reads the latest committed values, creates no
 * reactivity.
 *
 * Contract: never call the returned function during render; between a
 * render and its commit it still invokes the previous `fn` (updates on
 * passive-effect timing).
 */
export const useLatestCallback = <A extends unknown[], R>(
  fn: (...args: A) => R,
): ((...args: A) => R) => {
  const latest = useRef(fn);
  useExternalSyncEffect(() => {
    latest.current = fn;
  }, [fn]);
  // Library-contract memoization: stable identity is the entire point of
  // this hook, so `useCallback` is sanctioned here despite React Compiler.
  return useCallback((...args: A) => latest.current(...args), []);
};
