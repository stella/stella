import * as React from "react";

/**
 * The `md` breakpoint: the width at which the sidebar and the workspace shell
 * leave their compact, single-column layout.
 *
 * Held in `rem` to match Tailwind's `--breakpoint-md`, because the components
 * that read this hook lay out the rest of that same switch with `md:`
 * utilities. A `px` copy agrees only while the root font size is 16px, so it
 * drifts from the stylesheet the moment a reader enlarges type.
 */
const MD_BREAKPOINT = "48rem" as const;

/** The `md:` variant's own condition, as a media query. */
const MD_MEDIA_QUERY = `(min-width: ${MD_BREAKPOINT})` as const;

const subscribe = (onChange: () => void): (() => void) => {
  const mediaQueryList = window.matchMedia(MD_MEDIA_QUERY);
  mediaQueryList.addEventListener("change", onChange);
  return () => mediaQueryList.removeEventListener("change", onChange);
};

// `matchMedia` rather than `innerWidth`: the two disagree by the width of a
// classic scrollbar, and only the query answers the question the stylesheet
// asks.
const getSnapshot = (): boolean => !window.matchMedia(MD_MEDIA_QUERY).matches;
// The server has no viewport to measure. Assume the wide layout, so markup
// rendered without one carries the desktop chrome rather than the portalled
// compact substitutes, which render to nothing at all.
const getServerSnapshot = (): boolean => false;

/** True below `md`, where the layout collapses to a single column. */
export function useIsMobile() {
  return React.useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
