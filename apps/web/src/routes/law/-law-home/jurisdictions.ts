import type { REGION_BY_COUNTRY } from "@/features/case-law/case-law-jurisdiction";
import { isStatuteCountry, type StatuteCountry } from "@/lib/statute-route";

/** The two corpora the home dispatches an entry to. */
export type LawScope = "decisions" | "statutes";

export type LawHomeDescriptor = {
  /** The corpora this jurisdiction is covered by, in the order they are offered. */
  scopes: readonly LawScope[];
  /**
   * Identifiers a reader can try in the box, per scope. Every one must parse
   * as an identifier under the scope's grammar, and a scope the jurisdiction
   * does not list carries none.
   */
  examples: Record<LawScope, readonly string[]>;
};

/**
 * Derived from the case-law region map, so a jurisdiction added there without
 * a home descriptor fails typecheck rather than losing its examples silently.
 */
export type LawHomeJurisdiction = keyof typeof REGION_BY_COUNTRY;

export const LAW_HOME_JURISDICTIONS = {
  CZE: {
    scopes: ["decisions", "statutes"],
    examples: {
      decisions: ["22 Cdo 2653/2012", "ECLI:CZ:NS:2012:23.CDO.1572.2012.1"],
      statutes: ["89/2012 Sb.", "§ 2079 89/2012 Sb."],
    },
  },
  EU: {
    scopes: ["decisions"],
    examples: {
      decisions: ["C-131/12"],
      statutes: [],
    },
  },
  POL: {
    scopes: ["decisions"],
    examples: {
      decisions: ["II CSK 123/19"],
      statutes: [],
    },
  },
  SVK: {
    scopes: ["decisions", "statutes"],
    examples: {
      decisions: ["1Cdo/12/2020"],
      statutes: ["40/1964 Zb."],
    },
  },
} as const satisfies Record<LawHomeJurisdiction, LawHomeDescriptor>;

/** Expects the corpus form (`CZE`), which `fromCaseLawCountryParam` produces. */
export const isLawHomeJurisdiction = (
  country: string,
): country is LawHomeJurisdiction =>
  Object.hasOwn(LAW_HOME_JURISDICTIONS, country);

export const LAW_HOME_JURISDICTION_CODES = Object.keys(
  LAW_HOME_JURISDICTIONS,
).filter(isLawHomeJurisdiction);

export const lawHomeDescriptor = (
  country: string | undefined,
): LawHomeDescriptor | null =>
  country !== undefined && isLawHomeJurisdiction(country)
    ? LAW_HOME_JURISDICTIONS[country]
    : null;

/**
 * The statutes browser's country segment for a corpus country, when the
 * browser covers it. `STATUTE_COUNTRIES` is the authority; the descriptors'
 * `statutes` scope is bound to it by test.
 */
export const statuteCountryOf = (
  country: string | undefined,
): StatuteCountry | null => {
  if (country === undefined) {
    return null;
  }
  const segment = country.toLowerCase();
  return isStatuteCountry(segment) ? segment : null;
};
