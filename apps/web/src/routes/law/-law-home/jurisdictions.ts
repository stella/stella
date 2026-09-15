import type { REGION_BY_COUNTRY } from "@/features/case-law/case-law-jurisdiction";
import {
  isPublicStatuteCountry,
  type StatuteCountry,
} from "@/lib/statute-route";

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

const LAW_HOME_EXAMPLES = {
  CZE: {
    decisions: ["22 Cdo 2653/2012", "ECLI:CZ:NS:2012:23.CDO.1572.2012.1"],
    statutes: ["89/2012 Sb.", "§ 2079 89/2012 Sb."],
  },
  EU: {
    decisions: ["C-131/12"],
    statutes: [],
  },
  POL: {
    decisions: ["II CSK 123/19"],
    statutes: [],
  },
  SVK: {
    decisions: ["1Cdo/12/2020"],
    statutes: ["40/1964 Zb."],
  },
} as const satisfies Record<LawHomeJurisdiction, LawHomeDescriptor["examples"]>;

/** Expects the corpus form (`CZE`), which `fromCaseLawCountryParam` produces. */
export const isLawHomeJurisdiction = (
  country: string,
): country is LawHomeJurisdiction => Object.hasOwn(LAW_HOME_EXAMPLES, country);

export const LAW_HOME_JURISDICTION_CODES = Object.keys(
  LAW_HOME_EXAMPLES,
).filter(isLawHomeJurisdiction);

export const lawHomeDescriptor = (
  country: string | undefined,
): LawHomeDescriptor | null => {
  if (country === undefined || !isLawHomeJurisdiction(country)) {
    return null;
  }
  const examples = LAW_HOME_EXAMPLES[country];
  const hasStatutes = statuteCountryOf(country) !== null;
  return {
    scopes: hasStatutes ? ["decisions", "statutes"] : ["decisions"],
    examples: {
      decisions: examples.decisions,
      statutes: hasStatutes ? examples.statutes : [],
    },
  };
};

/**
 * The statutes browser's country segment for a corpus country, when the
 * public browser admits it under the shared publication policy.
 */
export const statuteCountryOf = (
  country: string | undefined,
): StatuteCountry | null => {
  if (country === undefined) {
    return null;
  }
  const segment = country.toLowerCase();
  return isPublicStatuteCountry(segment) ? segment : null;
};
