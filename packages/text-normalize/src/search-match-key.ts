/** UTF-16 range into the well-formed content searched by literal key helpers. */
type SearchMatchKeyRange = {
  end: number;
  start: number;
};

/**
 * Literal substring search over caller-owned match keys. No trimming or
 * folding is applied: callers whose policy differs from the highlighter's
 * fold keep control over case, accents, whitespace, and field boundaries.
 * Lone surrogates become U+FFFD in both inputs. Empty keys match every value.
 */
export const containsSearchMatchKey = (
  content: string,
  query: string,
): boolean => content.toWellFormed().includes(query.toWellFormed());

type FindSearchMatchKeyRangesOptions = {
  /** Inclusive UTF-16 offset; defaults to the start of the content. */
  start?: number;
  /** Exclusive UTF-16 offset; defaults to the end of the content. */
  end?: number;
  maxMatches?: number;
};

/**
 * Non-overlapping literal occurrences in caller-owned keys, with UTF-16
 * offsets into content after replacing lone surrogates with U+FFFD. Neither
 * input is trimmed or folded. Well-formed literals match whole Unicode scalars.
 * Only matches wholly inside [start, end) are returned. Bounds are truncated
 * and clamped to content; maxMatches is floored. NaN options, empty queries,
 * reversed windows, and nonpositive limits produce no matches.
 */
export const findSearchMatchKeyRanges = (
  content: string,
  query: string,
  options: FindSearchMatchKeyRangesOptions = {},
): SearchMatchKeyRange[] => {
  const start = Math.min(
    content.length,
    Math.max(0, Math.trunc(options.start ?? 0)),
  );
  const end = Math.min(
    content.length,
    Math.max(0, Math.trunc(options.end ?? content.length)),
  );
  const maxMatches = Math.max(
    0,
    Math.floor(options.maxMatches ?? Number.MAX_SAFE_INTEGER),
  );
  if (
    query.length === 0 ||
    !(start < end) ||
    maxMatches === 0 ||
    Number.isNaN(maxMatches)
  ) {
    return [];
  }

  const haystack = content.toWellFormed();
  const needle = query.toWellFormed();
  const matches: SearchMatchKeyRange[] = [];
  let searchFrom = start;
  while (searchFrom <= end - needle.length) {
    const matchStart = haystack.indexOf(needle, searchFrom);
    const matchEnd = matchStart + needle.length;
    if (matchStart === -1 || matchEnd > end) {
      break;
    }
    matches.push({ start: matchStart, end: matchEnd });
    if (matches.length >= maxMatches) {
      break;
    }
    searchFrom = matchEnd;
  }
  return matches;
};
