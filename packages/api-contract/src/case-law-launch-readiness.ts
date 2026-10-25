import { panic } from "better-result";
import * as v from "valibot";

import { vApiDate } from "./api-date";
import type { CaseLawJurisdiction } from "./case-law-jurisdictions";
import launchReadiness from "./launch-readiness.json" with { type: "json" };
import { publicCountriesFor } from "./public-country-capability";

/** Countries the public case-law browser has a complete routing/display model for. */
export const CASE_LAW_BROWSER_COUNTRIES = [
  "CZE",
  "EU",
  "HUN",
  "POL",
  "SVK",
] as const satisfies readonly CaseLawJurisdiction[];

export type CaseLawBrowserCountry = (typeof CASE_LAW_BROWSER_COUNTRIES)[number];

/** CLDR region keys for every country the case-law browser can represent. */
export const CASE_LAW_REGION_BY_COUNTRY = {
  CZE: "CZ",
  EU: "EU",
  HUN: "HU",
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
  lastCensusDate: vApiDate,
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

const ADMITTED_CASE_LAW_COUNTRIES = publicCountriesFor("caseLaw", "search");
const CASE_LAW_PAGE_COUNTRIES = publicCountriesFor("caseLaw", "pages");

const servingReceipts = parseCaseLawLaunchReadiness(launchReadiness);

type CaseLawExplicitLaunch = {
  decidedBy: string;
  decidedOn: string;
};

/** Countries launched to case-law search by an explicit decision; null means none. */
export const CASE_LAW_EXPLICIT_LAUNCHES = {
  CZE: null,
  EU: { decidedBy: "project owner", decidedOn: "2026-10-23" },
  HUN: { decidedBy: "project owner", decidedOn: "2026-10-23" },
  POL: { decidedBy: "project owner", decidedOn: "2026-10-20" },
  SVK: { decidedBy: "project owner", decidedOn: "2026-10-23" },
} as const satisfies Record<
  CaseLawBrowserCountry,
  CaseLawExplicitLaunch | null
>;

export const CASE_LAW_EXPLICIT_LAUNCH_COUNTRIES =
  CASE_LAW_BROWSER_COUNTRIES.filter(
    (country) => CASE_LAW_EXPLICIT_LAUNCHES[country] !== null,
  );

/**
 * Countries admitted to case-law search, the API search surfaces and MCP.
 * Each needs exactly one of a serving receipt or an explicit launch.
 * Pages, sitemaps and crawl use `PUBLIC_CASE_LAW_PAGE_COUNTRIES` instead.
 */
export const PUBLIC_CASE_LAW_COUNTRIES = ADMITTED_CASE_LAW_COUNTRIES.map(
  (country) => {
    const receipt = servingReceipts.find((candidate) => candidate === country);
    const explicit = CASE_LAW_EXPLICIT_LAUNCH_COUNTRIES.some(
      (candidate) => candidate === country,
    );
    if (receipt !== undefined && explicit) {
      return panic(
        "A country with a case-law serving receipt cannot also be an explicit launch.",
      );
    }
    if (receipt !== undefined) {
      return receipt;
    }
    if (!explicit) {
      return panic(
        "An admitted public country needs a case-law serving receipt.",
      );
    }
    const branded = v.safeParse(launchReadinessCountrySchema, country);
    if (!branded.success) {
      return panic("An explicit case-law launch must name a browser country.");
    }
    return branded.output;
  },
);
if (
  CASE_LAW_EXPLICIT_LAUNCH_COUNTRIES.some(
    (country) =>
      !ADMITTED_CASE_LAW_COUNTRIES.some((candidate) => candidate === country),
  )
) {
  panic(
    "An explicit case-law launch cannot admit a pending or withdrawn country.",
  );
}
if (
  servingReceipts.some(
    (country) =>
      !ADMITTED_CASE_LAW_COUNTRIES.some((candidate) => candidate === country),
  )
) {
  panic(
    "A case-law serving receipt cannot admit a pending or withdrawn country.",
  );
}

export const isPublicCaseLawCountry = (
  country: string,
): country is PublicCaseLawCountry =>
  PUBLIC_CASE_LAW_COUNTRIES.some((candidate) => candidate === country);

/**
 * A country whose pages open must have a case-law routing and display model:
 * opening one without it does not compile, so its pages, sitemaps and crawl
 * paths can never be dropped silently.
 */
const PAGES_PUBLIC_BROWSER_COUNTRIES: readonly CaseLawBrowserCountry[] =
  CASE_LAW_PAGE_COUNTRIES;

/**
 * Countries whose decision pages are served, listed in sitemaps and open to
 * crawlers: the pages-public countries plus the search-admitted ones. A page
 * country needs no serving receipt; the receipt gates search admission only.
 */
export const PUBLIC_CASE_LAW_PAGE_COUNTRIES: readonly PublicCaseLawCountry[] =
  PAGES_PUBLIC_BROWSER_COUNTRIES.map((country) => {
    const parsed = v.safeParse(launchReadinessCountrySchema, country);
    return parsed.success
      ? parsed.output
      : panic("A pages-public country needs a case-law browser model.");
  });

export const isPublicCaseLawPageCountry = (
  country: string,
): country is PublicCaseLawCountry =>
  PUBLIC_CASE_LAW_PAGE_COUNTRIES.some((candidate) => candidate === country);

/** Canonicalize a country at the public case-law page boundary. */
export const publicCaseLawPageCountry = (
  country: string,
): PublicCaseLawCountry | null => {
  const canonical = country.toUpperCase();
  return isPublicCaseLawPageCountry(canonical) ? canonical : null;
};

/** Canonicalize and admit a country at the public case-law search boundary. */
export const publicCaseLawCountry = (
  country: string,
): PublicCaseLawCountry | null => {
  const canonical = country.toUpperCase();
  return isPublicCaseLawCountry(canonical) ? canonical : null;
};
