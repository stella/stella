import type { Page } from "../layout-engine/types";

/**
 * Count how many pages belong to each section (by `Page.sectionIndex`, defaulting
 * to 0 for single-section documents), for resolving SECTIONPAGES. A field on a
 * page reads the count for that page's section.
 */
export function buildSectionPageCounts(
  pages: readonly Page[],
): Map<number, number> {
  const counts = new Map<number, number>();
  for (const page of pages) {
    const index = page.sectionIndex ?? 0;
    counts.set(index, (counts.get(index) ?? 0) + 1);
  }
  return counts;
}
