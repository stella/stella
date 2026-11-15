import { useSyncExternalStore } from "react";

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

const subscribe = (onChange: () => void): (() => void) => {
  const mediaQueryList = window.matchMedia(REDUCED_MOTION_QUERY);
  mediaQueryList.addEventListener("change", onChange);
  return () => mediaQueryList.removeEventListener("change", onChange);
};

const getSnapshot = (): boolean =>
  window.matchMedia(REDUCED_MOTION_QUERY).matches;

// Markup rendered without a viewport has no preference to read; motion is
// only ever started from an event handler, which runs in the browser.
const getServerSnapshot = (): boolean => false;

/**
 * Whether the person asked the system for reduced motion. For behaviour that
 * changes with the preference (a different control, not only a different
 * animation); a CSS-only difference belongs in the `motion-reduce:` variant.
 */
export const usePrefersReducedMotion = (): boolean =>
  useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
