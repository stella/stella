import type { Layout } from "../core/layout-engine/types";

export type PageScrollTarget =
  | {
      type: "position";
      pmPos: number;
    }
  | {
      type: "pageShell";
      pageIndex: number;
    };

export const isValidPmScrollPosition = (pmPos: number): boolean =>
  Number.isInteger(pmPos) && pmPos >= 0;

/**
 * Pick a `scrollIntoView` / `scrollTo` `behavior` that respects the
 * user's `prefers-reduced-motion` setting. Chrome silently no-ops
 * `behavior: "smooth"` when reduced motion is on (instead of falling
 * back to instant), so a stale "smooth" call from scroll-to-block
 * leaves the user wondering why the chip "doesn't work". Use the
 * helper everywhere we'd otherwise hard-code `"smooth"`.
 */
export const prefersReducedMotionBehavior = (): ScrollBehavior => {
  if (
    typeof window === "undefined" ||
    typeof window.matchMedia !== "function"
  ) {
    return "smooth";
  }
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ? "auto"
    : "smooth";
};

export const getPageScrollTarget = (
  layout: Layout | null,
  pageNumber: number,
): PageScrollTarget | null => {
  if (!layout || !Number.isInteger(pageNumber) || pageNumber < 1) {
    return null;
  }

  const pageIndex = pageNumber - 1;
  const page = layout.pages[pageIndex];
  if (!page) {
    return null;
  }

  const pmStart = page.fragments.at(0)?.pmStart;
  if (
    typeof pmStart === "number" &&
    Number.isInteger(pmStart) &&
    pmStart >= 0
  ) {
    return { type: "position", pmPos: pmStart };
  }

  return { type: "pageShell", pageIndex };
};
