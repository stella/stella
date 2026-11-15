/**
 * Which language version of a multilingual decision a reader is shown.
 *
 * One order, owned here, for every surface that picks a version: the rows of
 * a list (their keywords and headnote), the link a row opens, the newest
 * decisions shelf, and the version an AI analysis is offered in. The reader's
 * UI language comes first, then the languages of the jurisdictions they
 * practise in, then French, the working language of the Court of Justice, in
 * which nearly every one of its decisions is published. A decision in none of
 * them is read in its own language, the language of the case, which is the
 * only authentic version of a CJEU decision.
 */

import { normalizeCaseLawLanguageSegment } from "./case-law-decision-route";

/** The CJEU's working language: its deliberations and drafts are in French. */
export const CASE_LAW_WORKING_LANGUAGE = "fr";

/** The most reading languages a request carries; the order stops mattering. */
export const CASE_LAW_READING_LANGUAGES_MAX = 8;

/**
 * The official languages of a jurisdiction, by ISO 3166-1 alpha-2 code, the
 * most widely used first. A country absent here contributes no language: the
 * reader's UI language and French still apply.
 */
const OFFICIAL_LANGUAGES_BY_COUNTRY: Readonly<
  Record<string, readonly string[]>
> = {
  AT: ["de"],
  AU: ["en"],
  BE: ["nl", "fr", "de"],
  BG: ["bg"],
  BR: ["pt"],
  CA: ["en", "fr"],
  CH: ["de", "fr", "it"],
  CY: ["el"],
  CZ: ["cs"],
  DE: ["de"],
  DK: ["da"],
  EE: ["et"],
  ES: ["es"],
  FI: ["fi", "sv"],
  FR: ["fr"],
  GB: ["en"],
  GR: ["el"],
  HR: ["hr"],
  HU: ["hu"],
  IE: ["en", "ga"],
  IS: ["is"],
  IT: ["it"],
  LI: ["de"],
  LT: ["lt"],
  LU: ["fr", "de"],
  LV: ["lv"],
  MT: ["mt", "en"],
  NL: ["nl"],
  NO: ["nb"],
  NZ: ["en"],
  PL: ["pl"],
  PT: ["pt"],
  RO: ["ro"],
  SE: ["sv"],
  SI: ["sl"],
  SK: ["sk"],
  UA: ["uk"],
  US: ["en"],
};

/** `pt-BR` as `pt`: versions are compared by language, never by region. */
const primaryLanguage = (language: string | null | undefined): string | null =>
  normalizeCaseLawLanguageSegment(language)?.split("-")[0] ?? null;

/** The official languages of one jurisdiction; empty when none is recorded. */
export const jurisdictionLanguages = (countryCode: string): readonly string[] =>
  OFFICIAL_LANGUAGES_BY_COUNTRY[countryCode.trim().toUpperCase()] ?? [];

type CaseLawReadingLanguagesInput = {
  /** The language the UI runs in. */
  uiLocale: string;
  /** The reader's practice jurisdictions, the primary one first. */
  practiceCountries?: readonly string[] | undefined;
};

/**
 * The reader's languages, most preferred first, each once: the UI language,
 * the languages of their practice jurisdictions, then French. The language
 * of the case is not in it; it is the fallback for a decision in none of
 * them, which only the decision itself knows.
 */
export const caseLawReadingLanguages = ({
  uiLocale,
  practiceCountries = [],
}: CaseLawReadingLanguagesInput): readonly string[] => {
  const ordered = [
    primaryLanguage(uiLocale),
    ...practiceCountries.flatMap(jurisdictionLanguages),
    CASE_LAW_WORKING_LANGUAGE,
  ].filter((language): language is string => language !== null);
  return [...new Set(ordered)].slice(0, CASE_LAW_READING_LANGUAGES_MAX);
};

/**
 * Reading languages as a request states them, normalized and bounded: an
 * unreadable entry is dropped, never an error, because the order only ranks
 * versions that all exist.
 */
export const parseCaseLawReadingLanguages = (
  value: readonly string[] | string | undefined,
): readonly string[] => {
  const entries = typeof value === "string" ? value.split(",") : (value ?? []);
  const languages = entries
    .map(primaryLanguage)
    .filter((language): language is string => language !== null);
  return [...new Set(languages)].slice(0, CASE_LAW_READING_LANGUAGES_MAX);
};

/**
 * Where a version stands in the reader's order: its reading language's
 * position, then the language of the case, then every other version. Lower is
 * preferred; versions that tie keep the order they came in.
 */
export const caseLawLanguageVersionRank = (
  language: string,
  {
    readingLanguages,
    caseLanguage,
  }: { readingLanguages: readonly string[]; caseLanguage?: string | null },
): number => {
  const primary = primaryLanguage(language);
  const position = primary === null ? -1 : readingLanguages.indexOf(primary);
  if (position !== -1) {
    return position;
  }
  const authentic = primaryLanguage(caseLanguage);
  return authentic !== null && authentic === primary
    ? readingLanguages.length
    : readingLanguages.length + 1;
};

/**
 * The version of a multilingual decision to show the reader: the best by
 * `caseLawLanguageVersionRank`, the first listed among equals. The caller
 * that knows which version is in the language of the case says so; one that
 * does not (a list row's alternates) passes the version the server already
 * chose by the same order. Null only when there is nothing to choose from.
 */
export const pickCaseLawLanguageVersion = <
  TVersion extends { language: string },
>(
  versions: readonly TVersion[],
  options: {
    readingLanguages: readonly string[];
    caseLanguage?: string | null;
  },
): TVersion | null => {
  let best: TVersion | null = null;
  let bestRank = Number.POSITIVE_INFINITY;
  for (const version of versions) {
    const rank = caseLawLanguageVersionRank(version.language, options);
    if (rank < bestRank) {
      best = version;
      bestRank = rank;
    }
  }
  return best;
};
