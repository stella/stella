import { panic, Result } from "better-result";

import { parseIntegerToken } from "@stll/agent-input/numeric-token";

import { foldDecisionIdentifierInput } from "./decision-docket-grammar";

/**
 * The Supreme Court's official collection, the Sbírka soudních rozhodnutí a
 * stanovisek, as a reporter: the citations that name one of its entries and
 * the one spelling ingestion stores and resolve reads them by.
 *
 * The collection counts in two series per year, one for its civil part
 * (občanskoprávní, obchodní a správní věci) and one for its criminal part, so
 * a number and a year name an entry only together with the part. Citations
 * write the part in several ways, and some leave it out:
 *
 * - civil: `Rc 45/2012`, `R 45/2012 civ.`, `č. 45/2012 Sb. rozh. obč.`,
 *   `Sb. rozh. obč. 45/2012`, `… Sbírky soudních rozhodnutí a stanovisek,
 *   části civilní`;
 * - criminal: `Rt 45/2012`, `R 45/2012 tr.`, `č. 45/2012 Sb. rozh. tr.`,
 *   `Sb. rozh. tr. 45/2012`, `… Sbírky soudních rozhodnutí a stanovisek,
 *   části trestní`;
 * - part not stated: `R 9/1971`, `č. 9/1971 Sb. rozh.`, `Sbírka soudních
 *   rozhodnutí a stanovisek, sešit 1/1971, č. 9`.
 *
 * A citation that does not state its part names whichever entry carries that
 * number in either series, so it is read as its own identity (`R 9/1971`) that
 * every entry also carries. Lookup then finds one entry or two, and two are
 * reported as ambiguous rather than settled by guessing the part.
 */

export const CZ_NS_COLLECTION_PARTS = ["civil", "criminal"] as const;

export type CzNsCollectionPart = (typeof CZ_NS_COLLECTION_PARTS)[number];

/** An entry's place in the collection. */
export type CzNsCollectionPlace = {
  readonly part: CzNsCollectionPart;
  readonly number: number;
  readonly year: number;
};

/** A citation as read: the part is null when the citation leaves it out. */
export type CzNsCollectionCitation = Omit<CzNsCollectionPlace, "part"> & {
  readonly part: CzNsCollectionPart | null;
};

/** The collection runs from its interwar predecessor to today. */
const FIRST_YEAR = 1918;
const LAST_YEAR = 2100;
const MAX_NUMBER = 9999;

const PART_PREFIX = {
  civil: "Rc",
  criminal: "Rt",
} as const satisfies Record<CzNsCollectionPart, string>;

/** The canonical spelling of a citation, the part kept or left out as read. */
export const formatCzNsCollectionCitation = ({
  part,
  number,
  year,
}: CzNsCollectionCitation): string =>
  `${part === null ? "R" : PART_PREFIX[part]} ${number}/${year}`;

/**
 * The reporter citations one collection entry is stored under: its own,
 * stating the part, and the part-less one a citation leaving the part out
 * reads as.
 */
export const czNsCollectionIdentifierValues = (
  place: CzNsCollectionPlace,
): readonly [string, string] => [
  formatCzNsCollectionCitation(place),
  formatCzNsCollectionCitation({ ...place, part: null }),
];

const NUMBER_YEAR = String.raw`(?<number>\d{1,4})\s?\/\s?(?<year>\d{4})`;
const CIVIL_WORD = String.raw`(?:obč|ob|civ)`;
const CRIMINAL_WORD = String.raw`tr`;
const PART_WORD = String.raw`(?<partWord>${CIVIL_WORD}|${CRIMINAL_WORD})\.?`;
const COLLECTION_ABBREVIATION = String.raw`Sb\.\s?rozh\.?`;
const NUMBER_MARK = String.raw`(?:[čc]\.|čís\.|číslo|číslem|pod\s(?:[čc]\.|číslem))`;
const COLLECTION_NAME = String.raw`Sbír\p{L}{1,3}\ssoudních\srozhodnutí\sa\sstanovisek`;
/** `uveřejněný`, `publikované`: the words a citation introduces the number with. */
const PUBLISHED_WORD = String.raw`(?:uveřejněn|publikován)\p{L}{0,3}`;
const PART_PHRASE = String.raw`(?:,?\s(?:v\s)?část(?:i|í)?\s(?<partPhrase>civilní|občanskoprávní|trestní))`;

/** Every spelling read, whole entry only; spaces are already folded to one. */
const SPELLINGS: readonly RegExp[] = [
  // `R 9/1971`, `Rc 45/2012`, `Rt 45/2012`, `R 45/2012 civ.`, `R 45/2012 tr.`
  new RegExp(
    String.raw`^R(?<prefixPart>c|t)?\.?\s?${NUMBER_YEAR}(?:\s${COLLECTION_ABBREVIATION})?(?:\s${PART_WORD})?$`,
    "iu",
  ),
  // `č. 45/2012 Sb. rozh. obč.`, `45/2012 Sb. rozh. tr.`, `č. 9/1971 Sb. rozh.`
  new RegExp(
    String.raw`^(?:${NUMBER_MARK}\s?)?${NUMBER_YEAR}\s${COLLECTION_ABBREVIATION}(?:\s?${PART_WORD})?$`,
    "iu",
  ),
  // `Sb. rozh. obč. 45/2012`, `Sb. rozh. tr. č. 45/2012`
  new RegExp(
    String.raw`^${COLLECTION_ABBREVIATION}(?:\s?${PART_WORD})?\s(?:${NUMBER_MARK}\s?)?${NUMBER_YEAR}$`,
    "iu",
  ),
  // `Sbírka soudních rozhodnutí a stanovisek, část civilní, č. 45/2012`,
  // `uveřejněný pod číslem 45/2012 Sbírky soudních rozhodnutí a stanovisek,
  // části trestní`
  new RegExp(
    String.raw`^(?:${PUBLISHED_WORD}\s)?${NUMBER_MARK}\s?${NUMBER_YEAR}\s${COLLECTION_NAME}${PART_PHRASE}?$`,
    "iu",
  ),
  new RegExp(
    String.raw`^${COLLECTION_NAME}${PART_PHRASE}?,?\s${NUMBER_MARK}\s?${NUMBER_YEAR}$`,
    "iu",
  ),
  // `Sbírka soudních rozhodnutí a stanovisek, sešit 1/1971, č. 9`
  new RegExp(
    String.raw`^${COLLECTION_NAME}${PART_PHRASE}?,?\ssešit\s(?:č\.\s?)?\d{1,2}\/(?<year>\d{4}),?\s${NUMBER_MARK}\s?(?<number>\d{1,4})$`,
    "iu",
  ),
];

const partOfWord = (word: string): CzNsCollectionPart => {
  const folded = word.toLocaleLowerCase("cs");
  switch (folded) {
    case "c":
    case "obč":
    case "ob":
    case "civ":
    case "civilní":
    case "občanskoprávní":
      return "civil";
    case "t":
    case "tr":
    case "trestní":
      return "criminal";
    default:
      return panic(`Unhandled collection part word: ${word}`);
  }
};

/** The entry without the commas or semicolons a list left after it. */
const withoutTrailingSeparators = (text: string): string => {
  let end = text.length;
  while (end > 0 && (text[end - 1] === "," || text[end - 1] === ";")) {
    end -= 1;
  }
  return text.slice(0, end);
};

/**
 * A citation of the collection, read from a whole entry, or null when the
 * entry is not one. A citation stating its part twice must state it alike.
 */
export const parseCzNsCollectionCitation = (
  raw: string,
): CzNsCollectionCitation | null => {
  const text = withoutTrailingSeparators(foldDecisionIdentifierInput(raw));
  for (const spelling of SPELLINGS) {
    const groups = spelling.exec(text)?.groups;
    if (groups === undefined) {
      continue;
    }
    const number = parseIntegerToken(groups["number"], {
      sign: "unsigned",
      min: 1,
      max: MAX_NUMBER,
    });
    const year = parseIntegerToken(groups["year"], {
      sign: "unsigned",
      min: FIRST_YEAR,
      max: LAST_YEAR,
    });
    if (Result.isError(number) || Result.isError(year)) {
      return null;
    }
    const stated = [
      groups["prefixPart"],
      groups["partWord"],
      groups["partPhrase"],
    ]
      .filter((word): word is string => word !== undefined)
      .map(partOfWord);
    const [part = null, ...others] = stated;
    if (others.some((other) => other !== part)) {
      return null;
    }
    return { part, number: number.value, year: year.value };
  }
  return null;
};

/** The canonical spelling of a whole-entry collection citation, or null. */
export const canonicalCzNsCollectionCitation = (
  text: string,
): string | null => {
  const citation = parseCzNsCollectionCitation(text);
  return citation === null ? null : formatCzNsCollectionCitation(citation);
};
