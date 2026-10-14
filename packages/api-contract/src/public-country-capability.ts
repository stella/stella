// parser-output-unchanged: public admission metadata does not change parsed decision records.
// parser-output-unchanged: the pages/search surface split gates public reads only; parsed decision records are identical.
import { panic } from "better-result";
import * as v from "valibot";

/**
 * How far a country is open to the public.
 *
 * - `pending_public`: nothing is public.
 * - `pages_public`: the country's decision and statute pages are served,
 *   listed in the sitemaps and open to crawlers, but the country is not yet
 *   part of search, the API search surfaces or MCP.
 * - `admitted`: pages are public and the country is admitted to search, the
 *   API search surfaces and MCP.
 * - `withdrawn`: nothing is public any more.
 */
export type PublicCountryCapability =
  | "admitted"
  | "pages_public"
  | "pending_public"
  | "withdrawn";

/** The public surfaces a capability gates. A new surface needs a decision per state. */
export type PublicCountrySurface = "pages" | "search";

/** Total on both axes: a new state or surface cannot compile without a decision. */
export const PUBLIC_COUNTRY_SURFACE_OPEN = {
  pages: {
    admitted: true,
    pages_public: true,
    pending_public: false,
    withdrawn: false,
  },
  search: {
    admitted: true,
    pages_public: false,
    pending_public: false,
    withdrawn: false,
  },
} as const satisfies Record<
  PublicCountrySurface,
  Record<PublicCountryCapability, boolean>
>;

/** Public admission, independent of whether ingestion holds rows for a country. */
export const PUBLIC_COUNTRY_CAPABILITIES = {
  AUT: "pending_public",
  CZE: "admitted",
  EU: "pending_public",
  HUN: "pending_public",
  POL: "pending_public",
  SVK: "pages_public",
  USA: "pending_public",
} as const satisfies Record<string, PublicCountryCapability>;

export type PublicCountry = keyof typeof PUBLIC_COUNTRY_CAPABILITIES;

export const isPublicCountry = (country: string): country is PublicCountry =>
  Object.hasOwn(PUBLIC_COUNTRY_CAPABILITIES, country);

/** Advertising a country requires a capability: the keys are the only list. */
export const PUBLIC_COUNTRIES = Object.keys(PUBLIC_COUNTRY_CAPABILITIES).filter(
  isPublicCountry,
);

type AdmittedPublicCountry = {
  [
    Country in PublicCountry
  ]: (typeof PUBLIC_COUNTRY_CAPABILITIES)[Country] extends "admitted"
    ? Country
    : never;
}[PublicCountry];

export const ADMITTED_PUBLIC_COUNTRIES = PUBLIC_COUNTRIES.filter(
  (country): country is AdmittedPublicCountry =>
    PUBLIC_COUNTRY_CAPABILITIES[country] === "admitted",
);

type PublicCountryOnSurface<Surface extends PublicCountrySurface> = {
  [
    Country in PublicCountry
  ]: (typeof PUBLIC_COUNTRY_SURFACE_OPEN)[Surface][(typeof PUBLIC_COUNTRY_CAPABILITIES)[Country]] extends true
    ? Country
    : never;
}[PublicCountry];

/** Countries whose decision and statute pages are served, listed and crawlable. */
export const PAGES_PUBLIC_COUNTRIES = PUBLIC_COUNTRIES.filter(
  (country): country is PublicCountryOnSurface<"pages"> =>
    PUBLIC_COUNTRY_SURFACE_OPEN.pages[PUBLIC_COUNTRY_CAPABILITIES[country]],
);

export const PUBLIC_COUNTRY_UNAVAILABLE_CODE = "public_country_unavailable";

// parser-output-unchanged: the refusal's HTTP status affects responses only, not parsed records.
/**
 * The HTTP status the refusal answers with. The country is advertised but
 * holds no public law: an answered client outcome, like any other unavailable
 * public resource, never a server fault. `code` tells it apart from a miss.
 */
export const PUBLIC_COUNTRY_UNAVAILABLE_STATUS = 404;

export const publicCountryUnavailableSchema = v.strictObject({
  code: v.literal(PUBLIC_COUNTRY_UNAVAILABLE_CODE),
  status: v.literal("unavailable"),
  country: v.picklist(PUBLIC_COUNTRIES),
  reason: v.picklist(["pages_public", "pending_public", "withdrawn"]),
  message: v.string(),
  hint: v.string(),
});

export type PublicCountryUnavailable = v.InferOutput<
  typeof publicCountryUnavailableSchema
>;

type ClosedCapability = Exclude<PublicCountryCapability, "admitted">;

/**
 * What a refusal says, by why it was refused. A pages-public country is only
 * ever refused on search, and its pages stay public, so it must not be told
 * that public law is unavailable.
 */
const PUBLIC_COUNTRY_UNAVAILABLE_MESSAGE = {
  pages_public:
    "Public-law search is not available for this country; its public pages are.",
  pending_public: "Public law for this country is not available.",
  withdrawn: "Public law for this country is not available.",
} as const satisfies Record<ClosedCapability, string>;

/**
 * Why a capability is closed on a surface, or null when it is open. The table
 * decides; the switch narrows, and an admitted country closed on any surface
 * is a broken table.
 */
const closedReason = (
  surface: PublicCountrySurface,
  capability: PublicCountryCapability,
): ClosedCapability | null => {
  if (PUBLIC_COUNTRY_SURFACE_OPEN[surface][capability]) {
    return null;
  }
  switch (capability) {
    case "admitted":
      return panic("An admitted country must be open on every surface.");
    case "pages_public":
    case "pending_public":
    case "withdrawn":
      return capability;
    default:
      capability satisfies never;
      return panic("Unhandled public country capability.");
  }
};

/**
 * The same answer over an explicit capability map. The default map is the
 * contract; tests inject one to exercise a state no country holds today.
 */
export const publicCountryUnavailableIn = (
  capabilities: Readonly<Record<PublicCountry, PublicCountryCapability>>,
  input: string,
  surface: PublicCountrySurface,
): PublicCountryUnavailable | null => {
  const country = input.trim().toUpperCase();
  if (!isPublicCountry(country)) {
    return null;
  }
  const reason = closedReason(surface, capabilities[country]);
  if (reason === null) {
    return null;
  }
  const available = PUBLIC_COUNTRIES.filter(
    (candidate) =>
      PUBLIC_COUNTRY_SURFACE_OPEN[surface][capabilities[candidate]],
  );
  return {
    code: PUBLIC_COUNTRY_UNAVAILABLE_CODE,
    status: "unavailable",
    country,
    reason,
    message: PUBLIC_COUNTRY_UNAVAILABLE_MESSAGE[reason],
    hint: `Choose an available country: ${available.join(", ")}.`,
  };
};

/** Unknown countries remain input errors; advertised countries explain admission on the named surface. */
export const publicCountryUnavailable = (
  input: string,
  surface: PublicCountrySurface,
): PublicCountryUnavailable | null =>
  publicCountryUnavailableIn(PUBLIC_COUNTRY_CAPABILITIES, input, surface);
