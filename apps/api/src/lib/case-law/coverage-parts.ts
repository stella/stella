/**
 * The parts of the coverage answer that can go unread without failing the
 * rest. A part that was not read leaves its own figures in a typed unknown
 * state (a null, an unread completeness), and the answer names it.
 */
export const CASE_LAW_COVERAGE_PARTS = [
  "arrivals",
  "slice-completeness",
  "facets",
  "courts",
  "provision-processing",
] as const;

export type CaseLawCoveragePart = (typeof CASE_LAW_COVERAGE_PARTS)[number];

/** The unread parts in the order the list above names them, each once. */
export const orderedCoverageParts = (
  parts: Iterable<CaseLawCoveragePart>,
): CaseLawCoveragePart[] => {
  const unread = new Set(parts);
  return CASE_LAW_COVERAGE_PARTS.filter((part) => unread.has(part));
};
