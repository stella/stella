import { panic } from "better-result";
import * as v from "valibot";

import launchReadiness from "./launch-readiness.json";

/** Countries the public case-law browser has a complete routing/display model for. */
export const CASE_LAW_BROWSER_COUNTRIES = ["CZE", "EU", "POL", "SVK"] as const;

export type CaseLawBrowserCountry = (typeof CASE_LAW_BROWSER_COUNTRIES)[number];

/** CLDR region keys for every country the case-law browser can represent. */
export const CASE_LAW_REGION_BY_COUNTRY = {
  CZE: "CZ",
  EU: "EU",
  POL: "PL",
  SVK: "SK",
} as const satisfies Record<CaseLawBrowserCountry, string>;

const launchReadinessCountrySchema = v.pipe(
  v.picklist(CASE_LAW_BROWSER_COUNTRIES),
  v.brand("PublicCaseLawCountry"),
);

const launchReadinessEntrySchema = v.strictObject({
  country: launchReadinessCountrySchema,
  evalSetExists: v.literal(true),
  lastCensusDate: v.pipe(v.string(), v.isoDate()),
  lastCensusGreen: v.literal(true),
});

const launchReadinessSchema = v.array(launchReadinessEntrySchema);

export type PublicCaseLawCountry = v.InferOutput<
  typeof launchReadinessCountrySchema
>;

/**
 * The artifact is an inclusion list: every row carries all required facts.
 * Sorted unique rows keep generated updates deterministic.
 */
export const parseCaseLawLaunchReadiness = (
  value: unknown,
): readonly PublicCaseLawCountry[] => {
  const result = v.safeParse(launchReadinessSchema, value);
  if (!result.success) {
    return panic(
      "Launch readiness must contain only complete entries with ISO dates.",
    );
  }

  const countries: PublicCaseLawCountry[] = [];
  let previous: PublicCaseLawCountry | null = null;
  for (const { country } of result.output) {
    if (previous !== null && previous >= country) {
      return panic("Launch readiness countries must be unique and sorted.");
    }
    countries.push(country);
    previous = country;
  }

  return countries;
};

/** Countries the public case-law surfaces may enumerate or query. */
export const PUBLIC_CASE_LAW_COUNTRIES =
  parseCaseLawLaunchReadiness(launchReadiness);

export const isPublicCaseLawCountry = (
  country: string,
): country is PublicCaseLawCountry =>
  PUBLIC_CASE_LAW_COUNTRIES.some((candidate) => candidate === country);

/** Canonicalize and admit a country at the public case-law boundary. */
export const publicCaseLawCountry = (
  country: string,
): PublicCaseLawCountry | null => {
  const canonical = country.toUpperCase();
  return isPublicCaseLawCountry(canonical) ? canonical : null;
};
