import { panic } from "better-result";
import * as v from "valibot";

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
  lastCensusDate: v.pipe(v.string(), v.isoDate()),
  lastCensusGreen: v.literal(true),
});

const launchReadinessSchema = v.array(launchReadinessEntrySchema);

export type PublicCaseLawCountry = v.InferOutput<
  typeof launchReadinessCountrySchema
>;

type CaseLawLaunchException = {
  decidedBy: string;
  decidedOn: string;
  reason: string;
};

type CaseLawLaunchExceptionRecord = Readonly<
  Partial<Record<CaseLawBrowserCountry, CaseLawLaunchException>>
>;

/** Recorded exceptions for admitted countries whose serving receipt is pending. */
export const CASE_LAW_LAUNCH_EXCEPTIONS = {
  POL: {
    decidedBy: "project owner",
    decidedOn: "2026-10-20",
    reason: "launch for a demo before the serving census receipt exists",
  },
} as const satisfies CaseLawLaunchExceptionRecord;

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

type ValidateCaseLawLaunchAdmissionOptions = {
  admitted: readonly CaseLawBrowserCountry[];
  exceptions: CaseLawLaunchExceptionRecord;
  receipts: readonly PublicCaseLawCountry[];
};

/** Validate and brand the countries admitted by either accepted evidence path. */
export const validateCaseLawLaunchAdmission = ({
  admitted,
  exceptions,
  receipts,
}: ValidateCaseLawLaunchAdmissionOptions): readonly PublicCaseLawCountry[] => {
  for (const country of CASE_LAW_BROWSER_COUNTRIES) {
    const isAdmitted = admitted.some((candidate) => candidate === country);
    const hasException = exceptions[country] !== undefined;
    if (hasException && !isAdmitted) {
      panic("A case-law launch exception cannot name a non-admitted country.");
    }
  }

  const countries = admitted.map((country) => {
    const receipt = receipts.find((candidate) => candidate === country);
    const exception = exceptions[country];
    if (receipt !== undefined && exception !== undefined) {
      return panic(
        "An admitted public country cannot have both a serving receipt and a launch exception.",
      );
    }
    if (receipt !== undefined) {
      return receipt;
    }
    if (exception === undefined) {
      return panic(
        "An admitted public country needs a case-law serving receipt or launch exception.",
      );
    }
    return v.parse(launchReadinessCountrySchema, country);
  });

  if (
    receipts.some(
      (country) => !admitted.some((candidate) => candidate === country),
    )
  ) {
    panic(
      "A case-law serving receipt cannot admit a pending or withdrawn country.",
    );
  }
  return countries;
};

/**
 * Countries admitted to case-law search, the API search surfaces and MCP.
 * Pages, sitemaps and crawl use `PUBLIC_CASE_LAW_PAGE_COUNTRIES` instead.
 */
export const PUBLIC_CASE_LAW_COUNTRIES = validateCaseLawLaunchAdmission({
  admitted: ADMITTED_CASE_LAW_COUNTRIES,
  exceptions: CASE_LAW_LAUNCH_EXCEPTIONS,
  receipts: servingReceipts,
});

export const caseLawAdmissionBasis = (
  country: PublicCaseLawCountry,
): "recorded-launch-exception" | "serving-receipt" =>
  Object.keys(CASE_LAW_LAUNCH_EXCEPTIONS).some(
    (candidate) => candidate === country,
  )
    ? "recorded-launch-exception"
    : "serving-receipt";

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
