import { useLayoutEffect, useRef } from "react";
import type { RefObject } from "react";

/**
 * A ref that always holds the latest committed value, readable from
 * event handlers, imperative bridges, and async paths without making
 * them depend on the value.
 *
 * The write happens in a layout effect, so readers see the value of the
 * last committed render: post-commit event handlers and effects observe
 * this render's value, while anything running between an uncommitted
 * render and its commit still observes the previous one. Never read the
 * returned ref during render; derive render output from the value
 * directly instead.
 *
 * This is the value counterpart to `useLatestCallback` (apps/web) and
 * replaces hand-written render-body mirrors (`ref.current = value` in
 * the component body), which the React Compiler cannot model and
 * `no-ref-mirror` bans.
 */
export const useLatest = <T>(value: T): RefObject<T> => {
  const ref = useRef(value);
  useLayoutEffect(() => {
    ref.current = value;
  });
  return ref;
};
