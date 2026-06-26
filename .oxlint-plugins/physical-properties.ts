// Physical directional Tailwind classes (ml-, mr-, pl-, pr-, left-*, right-*,
// text-left/right, border-l/r, rounded-l/r/corners) are fixed to LTR and break
// RTL; logical equivalents (ms-, me-, ps-, pe-, start-*, end-*, text-start/end,
// border-s/e, rounded-s/e) adapt automatically.
//
// Single source of these patterns, shared by the no-physical-properties oxlint
// rule (apps/web / packages/ui / packages/folio `.tsx`) and the landing's
// .astro check (which oxlint cannot parse), so the two cannot drift.

export const PHYSICAL_PATTERNS: readonly RegExp[] = [
  /(?:^|[\s"'`{(])(?:-?)(?:[\w[\]:]*:)?(?:ml|mr|pl|pr)-/,
  /(?:^|[\s"'`{(])(?:[\w[\]:]*:)?text-(?:left|right)(?=["'\s`})]|$)/,
  /(?:^|[\s"'`{(])(?:[\w[\]:]*:)?border-[lr](?=[-\s"'`})]|$)/,
  /(?:^|[\s"'`{(])(?:[\w[\]:]*:)?rounded-(?:l|r|tl|tr|bl|br)(?=[-\s"'`})]|$)/,
  /(?:^|[\s"'`{(])(?:-?)(?:[\w[\]:]*:)?(?:left|right)-/,
  /(?:^|[\s"'`{(])(?:[\w[\]:]*:)?scroll-(?:ml|mr|pl|pr)-/,
];

export const hasPhysicalProperty = (value: string): boolean =>
  PHYSICAL_PATTERNS.some((pattern) => pattern.test(value));
