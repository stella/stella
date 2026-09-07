/**
 * Splitting rendered text on a find term, without React.
 */
/** A run of the rendered text, with whether the find term produced it. */
export type TextSegment = {
  matched: boolean;
  /** Where the run starts in the input, which is the run's only identity. */
  start: number;
  text: string;
};

/**
 * Split rendered text into matched and unmatched runs, case-insensitively.
 *
 * Case folds with `toLocaleLowerCase` on both sides and compares by code unit,
 * which is the closest a client can come to what Postgres `ILIKE` did without
 * reimplementing its collation. It is deliberately not a normalizing or
 * accent-insensitive compare: marking a run the server did not match on would
 * be a worse lie than leaving a run unmarked.
 *
 * The concatenated segments always equal the input, so a caller cannot lose or
 * duplicate text by rendering them.
 */
export const splitByMatch = (text: string, term: string): TextSegment[] => {
  if (term === "" || text === "") {
    return text === "" ? [] : [{ matched: false, start: 0, text }];
  }

  const haystack = text.toLocaleLowerCase();
  const needle = term.toLocaleLowerCase();
  // A term that folds to nothing (or grows) would make the offsets below index
  // the wrong string; leave the text alone rather than mark it wrongly.
  if (haystack.length !== text.length || needle.length === 0) {
    return [{ matched: false, start: 0, text }];
  }

  const segments: TextSegment[] = [];
  let cursor = 0;
  for (
    let at = haystack.indexOf(needle);
    at !== -1;
    at = haystack.indexOf(needle, cursor)
  ) {
    if (at > cursor) {
      segments.push({
        matched: false,
        start: cursor,
        text: text.slice(cursor, at),
      });
    }
    segments.push({
      matched: true,
      start: at,
      text: text.slice(at, at + needle.length),
    });
    cursor = at + needle.length;
  }
  if (cursor < text.length) {
    segments.push({ matched: false, start: cursor, text: text.slice(cursor) });
  }
  return segments;
};
