import * as React from "react";

const subscribe = (onChange: () => void): (() => void) => {
  window.addEventListener("resize", onChange);
  return () => window.removeEventListener("resize", onChange);
};

const getSnapshot = (): number => window.innerWidth;
// SSR has no viewport. Callers use this to clamp a docked pane against
// the space actually available, so report 0 and let them fall back to
// their own minimum rather than inventing a desktop-sized viewport.
const getServerSnapshot = (): number => 0;

/** Viewport width in CSS pixels, tracked across resizes. */
export function useViewportWidth() {
  return React.useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
