// One ref callback for several refs, stable across renders.
//
// `composeRefs(a, b)` (`@stll/ui/utils`) builds a new callback every time it
// runs. Called during render, that is a new ref identity on every render, so
// React detaches every member (cleanup, or a call with `null`) and attaches
// it again on every commit; a member that writes state or registers an
// observer turns that into a render loop. no-ref-callback-state-write rejects
// `composeRefs` during render and points here.
//
// Platform-neutral: no DOM access, so React Native surfaces may use it.
// Excluded from the React Compiler with the rest of this directory; the
// identity is kept stable by hand.
import { useMemo } from "react";
import type { Ref } from "react";

import { composeRefs } from "../lib/utils";

/**
 * `composeRefs(...refs)`, memoized on the member refs: the same callback for
 * as long as every member is the same ref, a new one (so React re-attaches)
 * exactly when one of them changes. Pass refs that are themselves stable (a
 * ref object, a `useState` setter, a ref from a hook or a prop); keep the
 * number of refs fixed for a call site.
 */
export const useComposedRefs = <T>(
  ...refs: (Ref<T> | undefined)[]
): ((node: T | null) => (() => void) | undefined) =>
  useMemo(() => composeRefs(...refs), refs);
