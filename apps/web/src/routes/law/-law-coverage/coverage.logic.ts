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
  listing: "caseLaw.coverage.reportedByListing",
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

/** Where the globe looks and how close: a longitude in degrees, a tilt in radians. */
export type CoverageGlobeFrame = {
  readonly longitude: number;
  readonly tilt: number;
  readonly scale: number;
};

/** Zoomed on Central Europe; the disc clip hides the cropped rim. */
export const CENTRAL_EUROPE_GLOBE_FRAME: CoverageGlobeFrame = {
  longitude: 17,
  tilt: 0.85,
  scale: 1.6,
};

/** How far from the disc's centre a pin may sit, as a share of its radius. */
const PIN_REACH = 0.9;

type Vector = readonly [number, number, number];

const radians = (degrees: number): number => (degrees * Math.PI) / 180;

const unitVector = (latitude: number, longitude: number): Vector => [
  Math.cos(radians(latitude)) * Math.cos(radians(longitude)),
  Math.cos(radians(latitude)) * Math.sin(radians(longitude)),
  Math.sin(radians(latitude)),
];

/**
 * A place's distance from the centre of an unzoomed disc looking at `frame`,
 * as a share of its radius: the sine of the arc between them. A place on the
 * far side is out of reach at any zoom.
 */
const distanceFromCentre = (
  frame: CoverageGlobeFrame,
  [latitude, longitude]: readonly [number, number],
): number => {
  const centre = unitVector((frame.tilt * 180) / Math.PI, frame.longitude);
  const place = unitVector(latitude, longitude);
  const cosine =
    centre[0] * place[0] + centre[1] * place[1] + centre[2] * place[2];
  return cosine <= 0
    ? Number.POSITIVE_INFINITY
    : Math.sqrt(Math.max(0, 1 - cosine * cosine));
};

/**
 * Central Europe while every pin shows there. Otherwise the globe turns to the
 * pins' mean direction and zooms out until each sits inside the disc, never
 * closer than Central Europe's zoom nor wider than the whole face.
 */
export const coverageGlobeFrame = (
  locations: readonly (readonly [number, number])[],
): CoverageGlobeFrame => {
  const reachOf = (frame: CoverageGlobeFrame): number =>
    Math.max(0, ...locations.map((place) => distanceFromCentre(frame, place)));
  const europe = CENTRAL_EUROPE_GLOBE_FRAME;
  if (europe.scale * reachOf(europe) <= PIN_REACH) {
    return europe;
  }
  let [x, y, z] = [0, 0, 0];
  for (const [latitude, longitude] of locations) {
    const vector = unitVector(latitude, longitude);
    x += vector[0];
    y += vector[1];
    z += vector[2];
  }
  const length = Math.hypot(x, y, z);
  if (length === 0) {
    return europe;
  }
  const centred = {
    longitude: (Math.atan2(y, x) * 180) / Math.PI,
    tilt: Math.asin(z / length),
    scale: 1,
  };
  const scale = Math.min(europe.scale, PIN_REACH / reachOf(centred));
  return { ...centred, scale: Math.max(1, scale) };
};
