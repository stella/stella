import type { PublicCountry } from "./public-country-capability";

/** A public country as the statute box and its route segments spell it. */
type StatuteCapabilityCountry = Lowercase<PublicCountry>;

/**
 * Whether the statute box can read act references for a country, and with
 * which grammar. A `gazette_number` country has a number grammar (with the
 * collection a bare number belongs to), aliases and gazette spellings; a
 * `magyar_kozlony` country reads the gazette's act designations
 * (`magyar-kozlony-designation`); every other public country searches titles
 * only.
 */
type StatuteQueryCapability =
  | { type: "supported"; grammar: "gazette_number"; defaultCollection: string }
  | { type: "supported"; grammar: "magyar_kozlony" }
  | { type: "unsupported"; reason: "no_query_grammar" };

const NO_QUERY_GRAMMAR = {
  type: "unsupported",
  reason: "no_query_grammar",
} as const satisfies StatuteQueryCapability;

/** Every public country, classified; the key set is the public country list. */
export const STATUTE_QUERY_CAPABILITIES = {
  aut: NO_QUERY_GRAMMAR,
  bra: NO_QUERY_GRAMMAR,
  cze: {
    type: "supported",
    grammar: "gazette_number",
    defaultCollection: "sb",
  },
  eu: NO_QUERY_GRAMMAR,
  gbr: NO_QUERY_GRAMMAR,
  hun: { type: "supported", grammar: "magyar_kozlony" },
  pol: NO_QUERY_GRAMMAR,
  svk: {
    type: "supported",
    grammar: "gazette_number",
    defaultCollection: "zz",
  },
  usa: NO_QUERY_GRAMMAR,
} as const satisfies Record<StatuteCapabilityCountry, StatuteQueryCapability>;

/** Countries with a statute query grammar of any kind. */
export type StatuteQueryCountry = {
  [
    Country in StatuteCapabilityCountry
  ]: (typeof STATUTE_QUERY_CAPABILITIES)[Country] extends {
    type: "supported";
  }
    ? Country
    : never;
}[StatuteCapabilityCountry];

/**
 * Countries whose acts are numbered in a gazette collection (`89/2012 Sb.`).
 * The alias, gazette and act tables are keyed by exactly this set, so a
 * country cannot be half-supported.
 */
export type StatuteGazetteCountry = {
  [
    Country in StatuteQueryCountry
  ]: (typeof STATUTE_QUERY_CAPABILITIES)[Country] extends {
    grammar: "gazette_number";
  }
    ? Country
    : never;
}[StatuteQueryCountry];

/** The ELI collection a bare `57/2008` belongs to in a gazette country. */
export type StatuteDefaultCollection<Country extends StatuteGazetteCountry> =
  (typeof STATUTE_QUERY_CAPABILITIES)[Country]["defaultCollection"];

/** Whether a supported country reads gazette numbers (`89/2012 Sb.`). */
export const isStatuteGazetteCountry = (
  country: StatuteQueryCountry,
): country is StatuteGazetteCountry =>
  STATUTE_QUERY_CAPABILITIES[country].grammar === "gazette_number";

/**
 * What the statute box can do for a country code as a caller holds it.
 * A code outside the public country list has no grammar either; the reason
 * says which case it is.
 */
export type StatuteQueryScope =
  | { type: "supported"; country: StatuteQueryCountry }
  | {
      type: "unsupported";
      reason: "no_query_grammar" | "unknown_country";
    };

const isStatuteCapabilityCountry = (
  country: string,
): country is StatuteCapabilityCountry =>
  Object.hasOwn(STATUTE_QUERY_CAPABILITIES, country);

const isStatuteQueryCountry = (
  country: StatuteCapabilityCountry,
): country is StatuteQueryCountry =>
  STATUTE_QUERY_CAPABILITIES[country].type === "supported";

/** Codes are matched as spelled: lower-case, as route segments carry them. */
export const readStatuteQueryScope = (country: string): StatuteQueryScope => {
  if (!isStatuteCapabilityCountry(country)) {
    return { type: "unsupported", reason: "unknown_country" };
  }
  if (isStatuteQueryCountry(country)) {
    return { type: "supported", country };
  }
  return {
    type: "unsupported",
    reason: STATUTE_QUERY_CAPABILITIES[country].reason,
  };
};
