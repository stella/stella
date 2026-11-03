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
type CaseLawCoverageAvailability = CaseLawCoverageCountry["availability"];
export type CaseLawSourceCompleteness = CaseLawCoverageSource["completeness"];
/** The two arms that carry both numbers, and so can carry a ratio. */
export type CaseLawMeasuredCompleteness = Extract<
  CaseLawSourceCompleteness,
  { reportedBy: string }
>;
export const CASE_LAW_COVERAGE_AVAILABILITY_LABEL_KEYS = {
  "in-preparation": "caseLaw.coverage.inPreparation",
  searchable: "caseLaw.coverage.searchable",
} as const satisfies Record<CaseLawCoverageAvailability, TranslationKey>;

export const CASE_LAW_COVERAGE_AVAILABILITY_TONES = {
  "in-preparation": "neutral",
  searchable: "success",
} as const satisfies Record<CaseLawCoverageAvailability, ReviewStatusTone>;

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
