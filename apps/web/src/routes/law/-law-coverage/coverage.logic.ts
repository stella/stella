import { compareByLocale } from "@stll/collation";
import type { ReviewStatusTone } from "@stll/ui/review-status-badge";

import type { caseLawCoverageOptions } from "@/features/case-law/queries/decisions";
import type { TranslationKey } from "@/i18n/types";

/** Either the figures, or the endpoint saying it cannot state them. */
export type CaseLawCoverageResponse = Awaited<
  ReturnType<NonNullable<ReturnType<typeof caseLawCoverageOptions>["queryFn"]>>
>;

export type CaseLawCoverage = Extract<
  CaseLawCoverageResponse,
  { countries: readonly unknown[] }
>;

export type CaseLawCoverageCountry = CaseLawCoverage["countries"][number];
export type CaseLawCoverageSource = CaseLawCoverageCountry["sources"][number];
export type CaseLawCoverageHealth = CaseLawCoverageCountry["health"];
type CaseLawCoverageAvailability = CaseLawCoverageCountry["availability"];
/** A count and the instant it was taken, never a bare number. */
export type CaseLawStoredCount = CaseLawCoverageCountry["stored"];
export type CaseLawSourceCompleteness = CaseLawCoverageSource["completeness"];
/** The two arms that carry both numbers, and so can carry a ratio. */
export type CaseLawMeasuredCompleteness = Extract<
  CaseLawSourceCompleteness,
  { reportedBy: string }
>;
type CaseLawTotalReporter = CaseLawMeasuredCompleteness["reportedBy"];

/**
 * One word per freshness state. The dot beside it carries the same state as a
 * tone, never on its own: colour is the second reading of the word, not the
 * only one.
 */
export const CASE_LAW_COVERAGE_HEALTH_LABEL_KEYS = {
  current: "caseLaw.coverage.healthCurrent",
  delayed: "caseLaw.coverage.healthDelayed",
  disabled: "caseLaw.coverage.healthDisabled",
  stalled: "caseLaw.coverage.healthStalled",
  unknown: "caseLaw.coverage.healthUnknown",
} as const satisfies Record<CaseLawCoverageHealth, TranslationKey>;

/**
 * `disabled` and `unknown` are neutral on purpose: a source switched off on
 * purpose, and one that has never run, are not faults and must not read as
 * one beside a court that genuinely stopped answering.
 */
export const CASE_LAW_COVERAGE_HEALTH_TONES = {
  current: "success",
  delayed: "warning",
  disabled: "neutral",
  stalled: "destructive",
  unknown: "neutral",
} as const satisfies Record<CaseLawCoverageHealth, ReviewStatusTone>;

export const CASE_LAW_COVERAGE_AVAILABILITY_LABEL_KEYS = {
  "in-preparation": "caseLaw.coverage.inPreparation",
  searchable: "caseLaw.coverage.searchable",
} as const satisfies Record<CaseLawCoverageAvailability, TranslationKey>;

export const CASE_LAW_COVERAGE_AVAILABILITY_TONES = {
  "in-preparation": "neutral",
  searchable: "success",
} as const satisfies Record<CaseLawCoverageAvailability, ReviewStatusTone>;

/** The warranty a stated total carries, which the page names rather than hides. */
export const CASE_LAW_TOTAL_REPORTER_LABEL_KEYS = {
  operator: "caseLaw.coverage.reportedByOperator",
  publisher: "caseLaw.coverage.reportedByPublisher",
} as const satisfies Record<CaseLawTotalReporter, TranslationKey>;

type OrderCoverageCountriesOptions<TCountry> = {
  countries: readonly TCountry[];
  /** The reader's locale, whose collation decides the order of the names. */
  locale: string;
  nameOf: (country: TCountry) => string;
};

/**
 * Countries in the order the reader's own language puts their names in.
 *
 * The payload arrives in ISO-code order, which orders codes, not the words
 * printed on the page: `CZE` before `EU` before `HUN` is not where a Czech or
 * a Hungarian reader expects to find their own country.
 */
export const orderCoverageCountriesByName = <TCountry>({
  countries,
  locale,
  nameOf,
}: OrderCoverageCountriesOptions<TCountry>): readonly TCountry[] => {
  const compare = compareByLocale(locale);
  return countries.toSorted((left, right) =>
    compare(nameOf(left), nameOf(right)),
  );
};

/** Why a source sits outside the percentage rather than inside it. */
export const CASE_LAW_COMPLETENESS_NOTE_KIND = {
  /** A total is recorded, but it is older than the freshness window. */
  STALE: "stale",
  /** A total is recorded, but the corpus has never been counted for it. */
  NOT_COUNTED: "not-counted",
  /** No total has ever been recorded. */
  NOT_MEASURED: "not-measured",
} as const;

export type CaseLawCompletenessNoteKind =
  (typeof CASE_LAW_COMPLETENESS_NOTE_KIND)[keyof typeof CASE_LAW_COMPLETENESS_NOTE_KIND];

/** A count of sources the percentage beside it deliberately leaves out. */
export type CaseLawCoverageCompletenessNote = {
  kind: CaseLawCompletenessNoteKind;
  count: number;
};

type CompletenessNoteCounts = {
  staleSources: number;
  notCountedSources: number;
  notMeasuredSources: number;
};

/**
 * What a country's percentage does not cover, stated beside it.
 *
 * A source nobody has measured, one whose total is out of date, and one the
 * corpus has never been counted for are all missing from the ratio. Left
 * unsaid, the ratio would read as the whole country; each one is therefore its
 * own count, and a state with no sources in it says nothing rather than
 * printing a zero.
 */
export const caseLawCoverageCompletenessNotes = ({
  notCountedSources,
  notMeasuredSources,
  staleSources,
}: CompletenessNoteCounts): readonly CaseLawCoverageCompletenessNote[] => {
  const notes = [
    {
      kind: CASE_LAW_COMPLETENESS_NOTE_KIND.NOT_MEASURED,
      count: notMeasuredSources,
    },
    { kind: CASE_LAW_COMPLETENESS_NOTE_KIND.STALE, count: staleSources },
    {
      kind: CASE_LAW_COMPLETENESS_NOTE_KIND.NOT_COUNTED,
      count: notCountedSources,
    },
  ] as const satisfies readonly CaseLawCoverageCompletenessNote[];
  return notes.filter(({ count }) => count > 0);
};
