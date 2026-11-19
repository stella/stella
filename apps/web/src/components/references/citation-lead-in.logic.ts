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

const LEADING_PUNCTUATION = /^[\p{P}\p{S}]+/u;
const EDGE_PUNCTUATION = /^[\p{P}\p{S}]$/u;

/**
 * Where the code point that ends at `end` starts: two code units back when
 * those two are one astral code point (a surrogate pair), else one.
 */
const codePointStart = (text: string, end: number) => {
  const pair = end - 2;
  return pair >= 0 && (text.codePointAt(pair) ?? 0) > 0xff_ff ? pair : end - 1;
};

/**
 * The word without the punctuation around it ("(NS)," reads "NS"). The start
 * goes with one start-anchored pattern; the end is walked back one code point
 * at a time, because a pattern anchored at the end would rescan a long run of
 * punctuation from every start.
 */
const trimEdgePunctuation = (word: string) => {
  const rest = word.replace(LEADING_PUNCTUATION, "");
  let end = rest.length;
  while (end > 0) {
    const start = codePointStart(rest, end);
    if (!EDGE_PUNCTUATION.test(rest.slice(start, end))) {
      break;
    }
    end = start;
  }
  return rest.slice(0, end);
};

const fold = (value: string) => value.toLocaleLowerCase("und");

const wordsOf = (text: string): string[] =>
  text
    .split(/\s+/u)
    .map((word) => fold(trimEdgePunctuation(word)))
    .filter((word) => word.length > 0);

const escapeRegExp = (value: string) =>
  value.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&");

// Court names are declined in the languages Stella reads ("Nejvyššího soudu",
// "Ústavného súdu", "Sądu Najwyższego"), so a word of the name and a prose word
// are the same word when they differ only by a case ending: "soud", "soudu"
// and "soudem" are one word, "soudní" (an adjective, as in "soudní rada") is
// another. Longest first, so "ího" goes before "í".
const CASE_ENDINGS: readonly string[] = [
  "ieho",
  "iemu",
  "ách",
  "ami",
  "ech",
  "ego",
  "ého",
  "emu",
  "ému",
  "ích",
  "ího",
  "ími",
  "ímu",
  "och",
  "ovi",
  "ých",
  "ými",
  "ám",
  "em",
  "es",
  "ia",
  "ie",
  "iu",
  "ím",
  "mi",
  "om",
  "ou",
  "ov",
  "ům",
  "ym",
  "ým",
  "a",
  "e",
  "é",
  "ě",
  "i",
  "í",
  "o",
  "s",
  "u",
  "ů",
  "y",
  "ý",
];

/** Shortest stem a case ending may leave, so "na" or "ve" stay whole. */
const MIN_STEM_LENGTH = 3;

const stemOf = (word: string) => {
  const ending = CASE_ENDINGS.find(
    (candidate) =>
      word.endsWith(candidate) &&
      word.length - candidate.length >= MIN_STEM_LENGTH,
  );
  return ending === undefined ? word : word.slice(0, -ending.length);
};

const namesWordRun = (prose: readonly string[], name: readonly string[]) => {
  if (name.length === 0 || name.length > prose.length) {
    return false;
  }
  const nameStems = name.map(stemOf);
  const proseStems = prose.map(stemOf);
  for (let start = 0; start + name.length <= prose.length; start += 1) {
    const matches = nameStems.every(
      (stem, offset) => proseStems[start + offset] === stem,
    );
    if (matches) {
      return true;
    }
  }
  return false;
};

/**
 * The registry's name patterns for the cited court: those that abbreviate a
 * court so and name the cited court itself. A short code is shared across
 * jurisdictions (`ÚS` is the Czech and the Slovak constitutional court), so
 * the Slovak name must not stand for a Czech decision.
 */
const namePatternsFor = ({
  court,
  courtShortCode,
}: CitedCourt): readonly RegExp[] =>
  Object.values(COURT_NAME_REGISTRY).flatMap((patterns) =>
    patterns
      .filter(
        (entry) =>
          entry.shortCode === courtShortCode && entry.pattern.test(court),
      )
      .map((entry) => entry.pattern),
  );

const LETTER = /\p{L}/u;

/** Whether `pattern` matches `text` ending at a word's end, not inside one. */
const matchesWholeWords = (pattern: RegExp, text: string) => {
  const match = pattern.exec(text);
  if (match === null) {
    return false;
  }
  const next = text[match.index + match[0].length];
  return next === undefined || !LETTER.test(next);
};

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
  return namePatternsFor({ court, courtShortCode: shortCode }).some((pattern) =>
    matchesWholeWords(pattern, nameText),
  );
};
