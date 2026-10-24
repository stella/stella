// parser-output-unchanged: exact-identity admission only changes read surfaces, not parsed decision records.
// parser-output-unchanged: public admission metadata does not change parsed decision records.
// parser-output-unchanged: the pages/search surface split gates public reads only; parsed decision records are identical.
import { panic } from "better-result";
import * as v from "valibot";

/**
 * How far a country is open to the public.
 *
 * - `pending_public`: nothing is public.
 * - `identity_public`: exact document identities and IDs are readable;
 *   public pages and search remain closed.
 * - `pages_public`: the domain's document pages are served,
 *   listed in the sitemaps and open to crawlers, but the country is not yet
 *   part of search, the API search surfaces or MCP.
 * - `admitted`: pages are public and the country is admitted to search, the
 *   API search surfaces and MCP.
 * - `withdrawn`: nothing is public any more.
 */
export type PublicCountryCapability =
  | "admitted"
  | "identity_public"
  | "pages_public"
  | "pending_public"
  | "withdrawn";

/** The public surfaces a capability gates. A new surface needs a decision per state. */
export type PublicCountrySurface = "identity" | "pages" | "search";

/** Total on both axes: a new state or surface cannot compile without a decision. */
export const PUBLIC_COUNTRY_SURFACE_OPEN = {
  identity: {
    admitted: true,
    identity_public: true,
    pages_public: true,
    pending_public: false,
    withdrawn: false,
  },
  pages: {
    admitted: true,
    identity_public: false,
    pages_public: true,
    pending_public: false,
    withdrawn: false,
  },
  search: {
    admitted: true,
    identity_public: false,
    pages_public: false,
    pending_public: false,
    withdrawn: false,
  },
} as const satisfies Record<
  PublicCountrySurface,
  Record<PublicCountryCapability, boolean>
>;

// parser-output-unchanged: scripts/parser-output-diff.ts reports every case-law adapter identical over its recorded fixtures with Slovak pages published; the change gates public reads only.
export const PUBLIC_LAW_DOMAIN = {
  caseLaw: "caseLaw",
  legislation: "legislation",
} as const;
export const PUBLIC_LAW_DOMAINS = Object.values(PUBLIC_LAW_DOMAIN);
export type PublicLawDomain =
  (typeof PUBLIC_LAW_DOMAIN)[keyof typeof PUBLIC_LAW_DOMAIN];

/** Public admission, independent of whether ingestion holds rows for a country. */
export const PUBLIC_COUNTRY_CAPABILITIES = {
  AUT: { caseLaw: "pending_public", legislation: "pending_public" },
  CZE: { caseLaw: "admitted", legislation: "admitted" },
  EU: { caseLaw: "identity_public", legislation: "pending_public" },
  GBR: { caseLaw: "pending_public", legislation: "pending_public" },
  HUN: { caseLaw: "pending_public", legislation: "pending_public" },
  // parser-output-unchanged: Poland's row is read by no parser; the EU and US parsers read only their own rows.
  POL: { caseLaw: "admitted", legislation: "pending_public" },
  SVK: { caseLaw: "pages_public", legislation: "pages_public" },
  USA: { caseLaw: "pending_public", legislation: "pending_public" },
} as const satisfies Record<
  string,
  Record<PublicLawDomain, PublicCountryCapability>
>;

export type PublicCountry = keyof typeof PUBLIC_COUNTRY_CAPABILITIES;

export const isPublicCountry = (country: string): country is PublicCountry =>
  Object.hasOwn(PUBLIC_COUNTRY_CAPABILITIES, country);

/** Advertising a country requires a capability: the keys are the only list. */
export const PUBLIC_COUNTRIES = Object.keys(PUBLIC_COUNTRY_CAPABILITIES).filter(
  isPublicCountry,
);

type PublicCountryOnSurface<
  Domain extends PublicLawDomain,
  Surface extends PublicCountrySurface,
> = {
  [
    Country in PublicCountry
  ]: (typeof PUBLIC_COUNTRY_SURFACE_OPEN)[Surface][(typeof PUBLIC_COUNTRY_CAPABILITIES)[Country][Domain]] extends true
    ? Country
    : never;
}[PublicCountry];

/** A caller must choose both its domain and surface; admission never crosses domains. */
export const publicCountriesFor = <
  Domain extends PublicLawDomain,
  Surface extends PublicCountrySurface,
>(
  domain: Domain,
  surface: Surface,
) =>
  PUBLIC_COUNTRIES.filter(
    (country): country is PublicCountryOnSurface<Domain, Surface> =>
      PUBLIC_COUNTRY_SURFACE_OPEN[surface][
        PUBLIC_COUNTRY_CAPABILITIES[country][domain]
      ],
  );

export const PUBLIC_COUNTRY_UNAVAILABLE_CODE = "public_country_unavailable";

// parser-output-unchanged: the refusal's HTTP status affects responses only, not parsed records.
/**
 * The HTTP status the refusal answers with. The country is advertised but
 * holds no public law: an answered client outcome, like any other unavailable
 * public resource, never a server fault. `code` tells it apart from a miss.
 */
export const PUBLIC_COUNTRY_UNAVAILABLE_STATUS = 404;

// parser-output-unchanged: refusal domains and copy affect API answers, not ingestion parsing.
export const publicCountryUnavailableSchema = v.strictObject({
  code: v.literal(PUBLIC_COUNTRY_UNAVAILABLE_CODE),
  status: v.literal("unavailable"),
  domain: v.picklist(PUBLIC_LAW_DOMAINS),
  country: v.picklist(PUBLIC_COUNTRIES),
  reason: v.picklist([
    "identity_public",
    "pages_public",
    "pending_public",
    "withdrawn",
  ]),
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
  caseLaw: {
    identity_public:
      "Only exact decision identity resolution and reading are available for this country.",
    pages_public:
      "Case-law search is not available for this country; its decision pages are.",
    pending_public: "Case law for this country is not available.",
    withdrawn: "Case law for this country is not available.",
  },
  legislation: {
    identity_public:
      "Only exact legislation identity resolution and reading are available for this country.",
    pages_public:
      "Legislation search is not available for this country; its legislation pages are.",
    pending_public: "Legislation for this country is not available.",
    withdrawn: "Legislation for this country is not available.",
  },
} as const satisfies Record<PublicLawDomain, Record<ClosedCapability, string>>;

const PUBLIC_COUNTRY_UNAVAILABLE_HINT = {
  caseLaw: "Choose a country with available case law:",
  legislation: "Choose a country with available legislation:",
} as const satisfies Record<PublicLawDomain, string>;

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
    case "identity_public":
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
export type PublicCountryCapabilities = Readonly<
  Record<
    PublicCountry,
    Readonly<Record<PublicLawDomain, PublicCountryCapability>>
  >
>;

type PublicCountryUnavailableOptions = {
  capabilities: PublicCountryCapabilities;
  domain: PublicLawDomain;
  input: string;
  surface: PublicCountrySurface;
};

export const publicCountryUnavailableIn = ({
  capabilities,
  domain,
  input,
  surface,
}: PublicCountryUnavailableOptions): PublicCountryUnavailable | null => {
  const country = input.trim().toUpperCase();
  if (!isPublicCountry(country)) {
    return null;
  }
  const reason = closedReason(surface, capabilities[country][domain]);
  if (reason === null) {
    return null;
  }
  const available = PUBLIC_COUNTRIES.filter(
    (candidate) =>
      PUBLIC_COUNTRY_SURFACE_OPEN[surface][capabilities[candidate][domain]],
  );
  return {
    code: PUBLIC_COUNTRY_UNAVAILABLE_CODE,
    status: "unavailable",
    domain,
    country,
    reason,
    message: PUBLIC_COUNTRY_UNAVAILABLE_MESSAGE[domain][reason],
    hint: `${PUBLIC_COUNTRY_UNAVAILABLE_HINT[domain]} ${available.join(", ")}.`,
  };
};

/** Unknown countries remain input errors; advertised countries explain admission on the named surface. */
type PublicCountrySurfaceOptions = {
  domain: PublicLawDomain;
  surface: PublicCountrySurface;
};

export const publicCountryUnavailable = (
  input: string,
  { domain, surface }: PublicCountrySurfaceOptions,
): PublicCountryUnavailable | null =>
  publicCountryUnavailableIn({
    capabilities: PUBLIC_COUNTRY_CAPABILITIES,
    domain,
    input,
    surface,
  });
