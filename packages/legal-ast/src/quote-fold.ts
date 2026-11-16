/**
 * Fold text so spellings that carry one meaning compare equal: curly and
 * straight quotes, the dashes, and whitespace. Keeps, per folded character,
 * its index in the original so a match maps back to original offsets.
 */

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

/**
 * `collapse` keeps one space per whitespace run, for text whose words are
 * reliably separated. `drop` removes whitespace, for text whose extraction
 * adds and loses spaces between words, such as a PDF page.
 */
export type QuoteFoldWhitespace = "collapse" | "drop";

/** The folded text plus, per folded character, its index in the original. */
export const foldQuoteText = (
  text: string,
  whitespace: QuoteFoldWhitespace,
): { folded: string; origin: number[] } => {
  let folded = "";
  const origin: number[] = [];
  let previousWasSpace = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text.charAt(index);
    if (WHITESPACE.test(character)) {
      if (whitespace === "collapse" && !previousWasSpace) {
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
