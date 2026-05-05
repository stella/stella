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
