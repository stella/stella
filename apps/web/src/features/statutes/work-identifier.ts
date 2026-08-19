/**
 * The identifier a corpus cites a work by, read off its ELI.
 *
 * An ELI addresses a work as `.../{year}/{number}/...` (the natural number
 * within a year's collection), while legal citation states the same pair the
 * other way round — `141/1961`, `89/2012` — and that citation form is the key
 * the case-law corpus records a provision reference under. This is the only
 * place the two forms are converted.
 *
 * It is a read of a published convention, not a parse of our own data, so it
 * answers null whenever the ELI does not state the pair: a caller then has no
 * work to ask about and offers nothing, rather than asking about the wrong
 * one.
 */

const YEAR_SEGMENT_RE = /^\d{4}$/u;
const NUMBER_SEGMENT_RE = /^\d+[a-z]?$/iu;

/** Years a collection can plausibly be published in; excludes bare numbers. */
const EARLIEST_YEAR = 1500;
const LATEST_YEAR = 2999;

const isYearSegment = (segment: string): boolean => {
  if (!YEAR_SEGMENT_RE.test(segment)) {
    return false;
  }

  const year = Number.parseInt(segment, 10);

  return year >= EARLIEST_YEAR && year <= LATEST_YEAR;
};

export const workIdentifierFromEli = (eli: string): string | null => {
  const segments = eli.split("/").filter((segment) => segment.length > 0);

  for (const [index, segment] of segments.entries()) {
    const next = segments[index + 1];

    if (
      isYearSegment(segment) &&
      next !== undefined &&
      !isYearSegment(next) &&
      NUMBER_SEGMENT_RE.test(next)
    ) {
      return `${next}/${segment}`;
    }
  }

  return null;
};
