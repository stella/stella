/**
 * Find a model's quote inside the block it cited, as offsets into the
 * block's own text.
 *
 * Models copy text faithfully but not byte-for-byte: they straighten curly
 * quotes, turn non-breaking spaces into spaces, and collapse runs of
 * whitespace. Those spellings carry one meaning, so they are matched; any
 * other difference is a misquote and is not.
 */

type Span = { start: number; end: number };

const EQUIVALENT_CHARACTERS: Readonly<Record<string, string>> = {
  "‘": "'",
  "’": "'",
  "‚": "'",
  "‛": "'",
  "“": '"',
  "”": '"',
  "„": '"',
  "‟": '"',
  "«": '"',
  "»": '"',
  "‹": "'",
  "›": "'",
  "–": "-",
  "—": "-",
  "−": "-",
};

const WHITESPACE = /\s/u;

/** The folded text plus, per folded character, its index in the original. */
const fold = (text: string): { folded: string; origin: number[] } => {
  let folded = "";
  const origin: number[] = [];
  let previousWasSpace = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text.charAt(index);
    if (WHITESPACE.test(character)) {
      if (!previousWasSpace) {
        folded += " ";
        origin.push(index);
      }
      previousWasSpace = true;
      continue;
    }
    previousWasSpace = false;
    folded += EQUIVALENT_CHARACTERS[character] ?? character;
    origin.push(index);
  }
  return { folded, origin };
};

/**
 * The span of `quote` in `text`, preferring the first occurrence at or after
 * `from` so repeated wording in one block maps to successive claims. Null
 * when the quote is not in the block.
 */
export const locateQuote = (
  text: string,
  quote: string,
  from = 0,
): Span | null => {
  const trimmed = quote.trim();
  if (trimmed.length === 0) {
    return null;
  }
  const exact = text.indexOf(trimmed, from);
  const exactAnywhere = exact === -1 ? text.indexOf(trimmed) : exact;
  if (exactAnywhere !== -1) {
    return { start: exactAnywhere, end: exactAnywhere + trimmed.length };
  }

  const haystack = fold(text);
  const needle = fold(trimmed).folded.trim();
  const foldedFrom = haystack.origin.findIndex((index) => index >= from);
  let at =
    foldedFrom === -1 ? -1 : haystack.folded.indexOf(needle, foldedFrom);
  if (at === -1) {
    at = haystack.folded.indexOf(needle);
  }
  if (at === -1) {
    return null;
  }
  const start = haystack.origin.at(at);
  const last = haystack.origin.at(at + needle.length - 1);
  if (start === undefined || last === undefined) {
    return null;
  }
  return { start, end: last + 1 };
};
