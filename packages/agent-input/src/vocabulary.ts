/**
 * Filter values whose allowed set comes from data: court names, decision types,
 * register sections.
 *
 * A closed schema enum is short and fixed, so `normalizeEnumValue` reads case
 * and spacing and asks about anything else. A data vocabulary is neither: it
 * holds hundreds of court names the model has only ever seen in running text,
 * where they appear with the country appended (`Ústavní soud České republiky`),
 * without diacritics, abbreviated, or cut short (`Krajský soud`). Each of those
 * still names one entry often enough to be worth reading, and names several
 * often enough that guessing would quietly filter to the wrong court.
 *
 * So the reader works in widening steps and stops at the first one that finds
 * exactly one entry: the value itself, the value folded, an alias folded, an
 * entry whose every word the input contains, then an entry that contains every
 * word of the input. Several at one step is an ask naming them.
 */

import { foldToAscii } from "@stll/text-normalize";

import { isAbsentPlaceholder } from "./absent";
import type { NormalizedOptional } from "./normalized";
import { askForFix, readAsAbsent, readValueAs } from "./normalized";

/** One allowed value, plus the other names it goes by in the data. */
export type VocabularyEntry = { value: string; aliases?: readonly string[] };

export type VocabularyOptions = {
  /** What the set is called in the ask: "The courts". */
  label?: string;
  /** What the set is, as a noun phrase for `expected`: "a court name". */
  expected?: string;
  /** How many values an ask names before "and N more". */
  maxListed?: number;
};

const DEFAULT_MAX_LISTED = 12;
const VOCABULARY_EXPECTED = "one of the known values";

/** Punctuation a name picks up in running text (`Nejvyšší soud ČR,`,
 *  `"Krajský soud"`) without changing which entry it names. */
const IGNORED_PUNCTUATION_RE = /[.,;:()"']/gu;
const WORD_JOINER_RE = /[-_]/gu;
const WHITESPACE_RE = /\s+/gu;

/** The comparison form: case, diacritics, punctuation and word joiners carry
 *  no meaning in a name drawn from data. */
const fold = (value: string): string =>
  foldToAscii(value)
    .toLowerCase()
    .replace(IGNORED_PUNCTUATION_RE, "")
    .replace(WORD_JOINER_RE, " ")
    .replace(WHITESPACE_RE, " ")
    .trim();

const tokensOf = (folded: string): ReadonlySet<string> =>
  new Set(folded === "" ? [] : folded.split(" "));

const isSubset = (
  inner: ReadonlySet<string>,
  outer: ReadonlySet<string>,
): boolean => [...inner].every((token) => outer.has(token));

/** Every spelling an entry answers to, as token sets. */
const formsOf = (entry: VocabularyEntry): readonly ReadonlySet<string>[] =>
  [entry.value, ...(entry.aliases ?? [])]
    .map((form) => tokensOf(fold(form)))
    .filter((tokens) => tokens.size > 0);

const quoteBounded = (values: readonly string[], maxListed: number): string => {
  const listed = values
    .slice(0, maxListed)
    .map((value) => `"${value}"`)
    .join(", ");
  const rest = values.length - maxListed;
  return rest > 0 ? `${listed}, and ${rest} more` : listed;
};

/** Values in the caller's order, each once: aliases of one entry, or two
 *  entries sharing a value, must not list it twice. */
const distinctValues = (entries: readonly VocabularyEntry[]): string[] => [
  ...new Set(entries.map((entry) => entry.value)),
];

/**
 * Read one value of a vocabulary drawn from data. A placeholder is no value; a
 * spelling that narrows to one entry reads as it with a note; a spelling that
 * matches several, or none, asks and names what there is.
 */
export const normalizeVocabularyValue = (
  input: unknown,
  entries: readonly VocabularyEntry[],
  options: VocabularyOptions = {},
): NormalizedOptional<string> => {
  const expected = options.expected ?? VOCABULARY_EXPECTED;
  const maxListed = options.maxListed ?? DEFAULT_MAX_LISTED;
  const allValues = distinctValues(entries);
  const listed =
    allValues.length === 0
      ? "No values are known for this filter; omit the property."
      : `${options.label ?? "The values"} include ${quoteBounded(allValues, maxListed)}.`;
  const askListing = () => askForFix({ input, expected, hint: listed });
  const askAmong = (candidates: readonly VocabularyEntry[]) =>
    askForFix({
      input,
      expected,
      hint: `Did you mean one of ${quoteBounded(distinctValues(candidates), maxListed)}?`,
    });

  if (typeof input !== "string") {
    return askListing();
  }
  if (isAbsentPlaceholder(input)) {
    return readAsAbsent(input);
  }

  const exact = entries.find((entry) => entry.value === input);
  if (exact !== undefined) {
    return readValueAs(input, exact.value);
  }

  // A folded value or alias two stored values share (two spellings of one
  // court, each given the same abbreviation) is two readings, never the first
  // one listed: filtering by either would drop the other's decisions.
  const folded = fold(input);
  const readOneOf = (matches: readonly VocabularyEntry[]) => {
    const [only, ...others] = distinctValues(matches);
    if (only === undefined) {
      return undefined;
    }
    return others.length === 0 ? readValueAs(input, only) : askAmong(matches);
  };
  const byValue = readOneOf(
    entries.filter((entry) => fold(entry.value) === folded),
  );
  if (byValue !== undefined) {
    return byValue;
  }
  const byAlias = readOneOf(
    entries.filter((entry) =>
      (entry.aliases ?? []).some((alias) => fold(alias) === folded),
    ),
  );
  if (byAlias !== undefined) {
    return byAlias;
  }

  const inputTokens = tokensOf(folded);
  if (inputTokens.size === 0) {
    return askListing();
  }

  // (a) The input names an entry and adds words of its own: the country after
  // a court's name, a seat, a chamber. The entry naming the most of the
  // input's words is the one meant; a tie is two readings.
  const contained = entries
    .map((entry) => ({
      entry,
      size: Math.max(
        0,
        ...formsOf(entry)
          .filter((tokens) => isSubset(tokens, inputTokens))
          .map((tokens) => tokens.size),
      ),
    }))
    .filter(({ size }) => size > 0);
  const largest = Math.max(0, ...contained.map(({ size }) => size));
  const containedBest = contained
    .filter(({ size }) => size === largest)
    .map(({ entry }) => entry);
  const [onlyContained, ...otherContained] = distinctValues(containedBest);
  if (onlyContained !== undefined) {
    return otherContained.length === 0
      ? readValueAs(input, onlyContained)
      : askAmong(containedBest);
  }

  // (b) The input is cut short: every word it has is in the entry, which has
  // more. One such entry is the one meant; several is the model naming a kind
  // of court rather than a court.
  const containing = entries.filter((entry) =>
    formsOf(entry).some((tokens) => isSubset(inputTokens, tokens)),
  );
  const [onlyContaining, ...otherContaining] = distinctValues(containing);
  if (onlyContaining === undefined) {
    return askListing();
  }
  return otherContaining.length === 0
    ? readValueAs(input, onlyContaining)
    : askAmong(containing);
};
