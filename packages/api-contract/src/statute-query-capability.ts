import type { PublicCountry } from "./public-country-capability";

/** A public country as the statute box and its route segments spell it. */
type StatuteCapabilityCountry = Lowercase<PublicCountry>;

/**
 * Whether the statute box can read act references for a country. A supported
 * country has a number grammar (with the collection a bare number belongs
 * to), aliases and gazette spellings; every other public country searches
 * titles only.
 */
type StatuteQueryCapability =
  | { type: "supported"; defaultCollection: string }
  | { type: "unsupported"; reason: "no_query_grammar" };

const NO_QUERY_GRAMMAR = {
  type: "unsupported",
  reason: "no_query_grammar",
} as const satisfies StatuteQueryCapability;

/** Every public country, classified; the key set is the public country list. */
export const STATUTE_QUERY_CAPABILITIES = {
  aut: NO_QUERY_GRAMMAR,
  cze: { type: "supported", defaultCollection: "sb" },
  eu: NO_QUERY_GRAMMAR,
  hun: NO_QUERY_GRAMMAR,
  pol: NO_QUERY_GRAMMAR,
  svk: { type: "supported", defaultCollection: "zz" },
  usa: NO_QUERY_GRAMMAR,
} as const satisfies Record<StatuteCapabilityCountry, StatuteQueryCapability>;

/**
 * Countries with a statute query grammar. The alias, gazette and act tables
 * are keyed by exactly this set, so a country cannot be half-supported.
 */
export type StatuteQueryCountry = {
  [
    Country in StatuteCapabilityCountry
  ]: (typeof STATUTE_QUERY_CAPABILITIES)[Country] extends {
    type: "supported";
  }
    ? Country
    : never;
}[StatuteCapabilityCountry];

/** The ELI collection a bare `57/2008` belongs to in a supported country. */
export type StatuteDefaultCollection<Country extends StatuteQueryCountry> =
  (typeof STATUTE_QUERY_CAPABILITIES)[Country]["defaultCollection"];

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
