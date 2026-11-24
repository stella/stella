import { foldSearchMatchText } from "@stll/text-normalize";

/**
 * A list of files or messages gets a search field from this many rows up;
 * a shorter one is read at a glance.
 */
export const LIST_SEARCH_MIN_ROWS = 6;

/** The query's words, folded as the texts they are matched against. */
const queryWords = (query: string): string[] =>
  foldSearchMatchText(query)
    .split(/\s+/u)
    .filter((word) => word.length > 0);

/**
 * Whether a row's shown texts hold every word of the query, ignoring case
 * and accents, in any order and any of its texts. An empty query matches
 * every row.
 */
export const listRowMatches = (
  texts: readonly (string | null | undefined)[],
  query: string,
): boolean => {
  const words = queryWords(query);
  if (words.length === 0) {
    return true;
  }
  const shown = texts
    .flatMap((text) =>
      text === null || text === undefined ? [] : [foldSearchMatchText(text)],
    )
    .join("\n");
  return words.every((word) => shown.includes(word));
};
