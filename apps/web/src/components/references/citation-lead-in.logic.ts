import { COURT_NAME_REGISTRY } from "@stll/api-contract/case-law-court-abbreviations";

/**
 * Whether the words just before an inline decision citation already name its
 * court, so the citation can drop the court badge instead of repeating it:
 * "Shodně NS [NS] 30 Cdo 3047/2012" reads "Shodně NS 30 Cdo 3047/2012".
 *
 * The rule is "the badge yields to the prose", never "the prose yields to the
 * badge": the model's own words stay exactly as written, so a quoted or
 * selected passage still matches what the answer says, and only the chip's
 * chrome changes. The case number the chip shows is still the registry's.
 *
 * "Just before" is the last few words (`LEAD_IN_WORDS`): enough for a court
 * followed by the kind of decision ("Ústavní soud v nálezu …") and short
 * enough that a court named earlier in a long sentence does not count.
 */

/** Words before the citation that can still name its court. */
const LEAD_IN_WORDS = 4;

/** Trailing characters the lead-in is cut to before its words are read. */
export const LEAD_IN_MAX_LENGTH = 96;

type CitedCourt = {
  /** The court's name as the publisher spells it ("Nejvyšší soud"). */
  court: string;
  /** The abbreviation the badge shows ("NS"). */
  courtShortCode: string;
};

const WORD_EDGE_PUNCTUATION = /^[\p{P}\p{S}]+|[\p{P}\p{S}]+$/gu;

const fold = (value: string) => value.toLocaleLowerCase("und");

const wordsOf = (text: string): string[] =>
  text
    .split(/\s+/u)
    .map((word) => fold(word.replaceAll(WORD_EDGE_PUNCTUATION, "")))
    .filter((word) => word.length > 0);

const escapeRegExp = (value: string) =>
  value.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&");

// Court names are declined in the languages Stella reads ("Nejvyššího soudu",
// "Ústavného súdu"), so a word of the name matches a prose word that starts
// with its stem. Short words ("v", "SR", "súd") match as a prefix whole.
const stemOf = (word: string) =>
  word.length <= 4 ? word : word.slice(0, Math.max(4, word.length - 3));

const namesWordRun = (prose: readonly string[], name: readonly string[]) => {
  if (name.length === 0 || name.length > prose.length) {
    return false;
  }
  for (let start = 0; start + name.length <= prose.length; start += 1) {
    const matches = name.every((word, offset) =>
      (prose[start + offset] ?? "").startsWith(stemOf(word)),
    );
    if (matches) {
      return true;
    }
  }
  return false;
};

/** The court name patterns of every jurisdiction that abbreviates a court so. */
const namePatternsFor = (shortCode: string): readonly RegExp[] =>
  Object.values(COURT_NAME_REGISTRY).flatMap((patterns) =>
    patterns
      .filter((entry) => entry.shortCode === shortCode)
      .map((entry) => entry.pattern),
  );

export const leadInNamesCourt = (
  leadIn: string,
  { court, courtShortCode }: CitedCourt,
): boolean => {
  const prose = leadIn.slice(-LEAD_IN_MAX_LENGTH).trim();
  if (prose === "") {
    return false;
  }
  const shortCode = courtShortCode.trim();
  const nameWords = wordsOf(court);
  // The full name may run longer than the window of loose words before the
  // citation; it gets its own words on top.
  const allWords = wordsOf(prose);
  const window = allWords.slice(-LEAD_IN_WORDS).join(" ");
  if (
    shortCode !== "" &&
    new RegExp(
      `(?:^|[^\\p{L}\\p{N}])${escapeRegExp(fold(shortCode))}(?:$|[^\\p{L}\\p{N}])`,
      "u",
    ).test(window)
  ) {
    return true;
  }
  const nameWindow = allWords.slice(-(LEAD_IN_WORDS + nameWords.length));
  if (namesWordRun(nameWindow, nameWords)) {
    return true;
  }
  const nameText = nameWindow.join(" ");
  return namePatternsFor(shortCode).some((pattern) => pattern.test(nameText));
};
