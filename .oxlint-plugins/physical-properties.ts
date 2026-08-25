// Physical directional Tailwind classes (ml-, mr-, pl-, pr-, left-*, right-*,
// text-left/right, border-l/r, rounded-l/r/corners) are fixed to LTR and break
// RTL; logical equivalents (ms-, me-, ps-, pe-, start-*, end-*, text-start/end,
// border-s/e, rounded-s/e) adapt automatically.
//
// Single source of these patterns, shared by the no-physical-properties oxlint
// rule (apps/web / packages/ui / packages/folio `.tsx`) and the landing's
// .astro check (which oxlint cannot parse), so the two cannot drift.

const PHYSICAL_REPLACEMENTS = [
  (value) =>
    value.replace(/(^|[\s"'`{(])(-?)((?:[\w[\]:]*:)?)ml-/gu, "$1$2$3ms-"),
  (value) =>
    value.replace(/(^|[\s"'`{(])(-?)((?:[\w[\]:]*:)?)mr-/gu, "$1$2$3me-"),
  (value) =>
    value.replace(/(^|[\s"'`{(])(-?)((?:[\w[\]:]*:)?)pl-/gu, "$1$2$3ps-"),
  (value) =>
    value.replace(/(^|[\s"'`{(])(-?)((?:[\w[\]:]*:)?)pr-/gu, "$1$2$3pe-"),
  (value) =>
    value.replace(
      /(^|[\s"'`{(])((?:[\w[\]:]*:)?)text-left(?=["'\s`})]|$)/gu,
      "$1$2text-start",
    ),
  (value) =>
    value.replace(
      /(^|[\s"'`{(])((?:[\w[\]:]*:)?)text-right(?=["'\s`})]|$)/gu,
      "$1$2text-end",
    ),
  (value) =>
    value.replace(
      /(^|[\s"'`{(])((?:[\w[\]:]*:)?)border-l(?=[-\s"'`})]|$)/gu,
      "$1$2border-s",
    ),
  (value) =>
    value.replace(
      /(^|[\s"'`{(])((?:[\w[\]:]*:)?)border-r(?=[-\s"'`})]|$)/gu,
      "$1$2border-e",
    ),
  (value) =>
    value.replace(
      /(^|[\s"'`{(])((?:[\w[\]:]*:)?)rounded-tl(?=[-\s"'`})]|$)/gu,
      "$1$2rounded-ss",
    ),
  (value) =>
    value.replace(
      /(^|[\s"'`{(])((?:[\w[\]:]*:)?)rounded-tr(?=[-\s"'`})]|$)/gu,
      "$1$2rounded-se",
    ),
  (value) =>
    value.replace(
      /(^|[\s"'`{(])((?:[\w[\]:]*:)?)rounded-bl(?=[-\s"'`})]|$)/gu,
      "$1$2rounded-es",
    ),
  (value) =>
    value.replace(
      /(^|[\s"'`{(])((?:[\w[\]:]*:)?)rounded-br(?=[-\s"'`})]|$)/gu,
      "$1$2rounded-ee",
    ),
  (value) =>
    value.replace(
      /(^|[\s"'`{(])((?:[\w[\]:]*:)?)rounded-l(?=[-\s"'`})]|$)/gu,
      "$1$2rounded-s",
    ),
  (value) =>
    value.replace(
      /(^|[\s"'`{(])((?:[\w[\]:]*:)?)rounded-r(?=[-\s"'`})]|$)/gu,
      "$1$2rounded-e",
    ),
  (value) =>
    value.replace(/(^|[\s"'`{(])(-?)((?:[\w[\]:]*:)?)left-/gu, "$1$2$3start-"),
  (value) =>
    value.replace(/(^|[\s"'`{(])(-?)((?:[\w[\]:]*:)?)right-/gu, "$1$2$3end-"),
  (value) =>
    value.replace(
      /(^|[\s"'`{(])((?:[\w[\]:]*:)?)scroll-ml-/gu,
      "$1$2scroll-ms-",
    ),
  (value) =>
    value.replace(
      /(^|[\s"'`{(])((?:[\w[\]:]*:)?)scroll-mr-/gu,
      "$1$2scroll-me-",
    ),
  (value) =>
    value.replace(
      /(^|[\s"'`{(])((?:[\w[\]:]*:)?)scroll-pl-/gu,
      "$1$2scroll-ps-",
    ),
  (value) =>
    value.replace(
      /(^|[\s"'`{(])((?:[\w[\]:]*:)?)scroll-pr-/gu,
      "$1$2scroll-pe-",
    ),
] as const satisfies readonly ((value: string) => string)[];

// Tailwind arbitrary values and selectors may contain prose or CSS whose
// physical-looking words are data, not utility names. Apply a replacement only
// outside balanced square brackets; an unclosed bracket conservatively protects
// the rest of the value.
const replaceOutsideArbitraryBrackets = (
  value: string,
  replace: (segment: string) => string,
): string => {
  let result = "";
  let segmentStart = 0;
  let bracketStart = 0;
  let depth = 0;
  let escaped = false;

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character === "\\" && !escaped) {
      escaped = true;
      continue;
    }
    if (!escaped && character === "[") {
      if (depth === 0) {
        result += replace(value.slice(segmentStart, index));
        bracketStart = index;
      }
      depth += 1;
    } else if (!escaped && character === "]" && depth > 0) {
      depth -= 1;
      if (depth === 0) {
        result += value.slice(bracketStart, index + 1);
        segmentStart = index + 1;
      }
    }
    escaped = false;
  }

  if (depth > 0) {
    return result + value.slice(bracketStart);
  }
  return result + replace(value.slice(segmentStart));
};

export const replacePhysicalProperties = (value: string): string => {
  let replaced = value;
  for (const replace of PHYSICAL_REPLACEMENTS) {
    replaced = replaceOutsideArbitraryBrackets(replaced, replace);
  }
  return replaced;
};

export const hasPhysicalProperty = (value: string): boolean =>
  PHYSICAL_REPLACEMENTS.some((replace) => replace(value) !== value);
