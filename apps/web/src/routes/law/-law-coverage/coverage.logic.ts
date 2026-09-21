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
