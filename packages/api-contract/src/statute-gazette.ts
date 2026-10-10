// parser-output-unchanged: shared reporter suffix preserves the existing citation grammar
import type {
  StatuteDefaultCollection,
  StatuteQueryCountry,
} from "./statute-query-capability";

/** Suffixes that identify case-law reporters sharing the Czech Sb. prefix. */
export const CZE_CASE_LAW_REPORTER_SUFFIX_SOURCE = String.raw`(?:NSS|rozh\.)`;

// A lenient gazette match can leave Sb.'s optional dot in the tail when the
// reporter follows it without whitespace. Both tails identify the reporter.
export const CZE_CASE_LAW_REPORTER_TAIL_RE = new RegExp(
  String.raw`^\.? ?${CZE_CASE_LAW_REPORTER_SUFFIX_SOURCE}(?![\p{L}\p{N}])`,
  "iu",
);

/** How a collection is printed from a given year on. */
type StatuteGazetteSpelling = { fromYear: number; abbreviation: string };

type StatuteGazetteSpellings = readonly [
  StatuteGazetteSpelling,
  ...StatuteGazetteSpelling[],
];

/**
 * Each publisher collection, keyed by the collection segment of its ELI
 * (`/eli/cz/sm/2008/57`), with the abbreviation lawyers print for it. Slovak
 * law cites acts of the federal era as `Zb.` and its own (from 1993) as
 * `Z. z.`, though Slov-Lex files both under `zz`. Spellings are ordered by
 * `fromYear`.
 */
export const STATUTE_GAZETTES = {
  cze: {
    sb: [{ fromYear: 0, abbreviation: "Sb." }],
    sm: [{ fromYear: 0, abbreviation: "Sb. m. s." }],
  },
  svk: {
    zz: [
      { fromYear: 0, abbreviation: "Zb." },
      { fromYear: 1993, abbreviation: "Z. z." },
    ],
  },
} as const satisfies {
  // A country's default collection must be one it publishes.
  [Country in StatuteQueryCountry]: Record<
    StatuteDefaultCollection<Country>,
    StatuteGazetteSpellings
  > &
    Record<string, StatuteGazetteSpellings>;
};

const SPELLINGS_BY_ELI_COLLECTION: ReadonlyMap<
  string,
  readonly StatuteGazetteSpelling[]
> = new Map(
  Object.values(STATUTE_GAZETTES).flatMap((collections) =>
    Object.entries(collections),
  ),
);

const ELI_COLLECTION_BY_ABBREVIATION: ReadonlyMap<string, string> = new Map(
  [...SPELLINGS_BY_ELI_COLLECTION].flatMap(([eliCollection, spellings]) =>
    spellings.map(({ abbreviation }) => [abbreviation, eliCollection] as const),
  ),
);

/** The ELI collection segment of a printed abbreviation (`Zb.` → `zz`). */
export const statuteGazetteEliCollection = (
  abbreviation: string,
): string | null => ELI_COLLECTION_BY_ABBREVIATION.get(abbreviation) ?? null;

/**
 * The abbreviation an act in an ELI collection segment prints for its year
 * (`zz`, 1964 → `Zb.`), or null for a collection without a known one.
 */
export const statuteGazetteAbbreviation = (
  eliCollection: string,
  year: number,
): string | null =>
  SPELLINGS_BY_ELI_COLLECTION.get(eliCollection)?.findLast(
    ({ fromYear }) => year >= fromYear,
  )?.abbreviation ?? null;
