// Shared backend dispatch for business-registry lookups.
//
// Single source of truth for the per-registry "this is how you look
// something up here" behaviour. Both the REST endpoint
// (`/contacts/business-registries`) and the chat tool
// (`business_registry_lookup`) drive their lookups through
// `executeRegistryLookup` so the two surfaces never drift in error
// mapping, normalisation, or shape detection.

import { panic } from "better-result";

import {
  AresAPIError,
  type AresAddress,
  type AresCompany,
  AresRequestError,
  type AresSearchResult,
  AresTooBroadError,
  AresValidationError,
  lookupByIco,
  normalizeIco,
  searchByName as searchAresByName,
} from "@stll/business-registries/ares";
import {
  BrregAPIError,
  type BrregEntity,
  BrregRequestError,
  type BrregSearchResult,
  BrregTooBroadError,
  BrregValidationError,
  lookupByOrgnr,
  normalizeOrgnr,
  searchByName as searchBrregByName,
} from "@stll/business-registries/brreg";
import {
  PrhAPIError,
  type PrhCompany,
  PrhRequestError,
  type PrhSearchResult,
  PrhValidationError,
  lookupByBusinessId,
  normalizeBusinessId,
  searchByName as searchPrhByName,
} from "@stll/business-registries/prh";
import {
  hasCanonicalShape as hasRechercheEntreprisesShape,
  lookupBySiren,
  lookupBySiret,
  normalizeSiren,
  RechercheEntreprisesAPIError,
  type RechercheEntreprisesCompany,
  RechercheEntreprisesRequestError,
  type RechercheEntreprisesSearchResult,
  RechercheEntreprisesValidationError,
  searchByName as searchRechercheEntreprisesByName,
} from "@stll/business-registries/recherche-entreprises";
import type { CountryCode } from "@stll/country-codes";

import { HandlerError } from "@/api/lib/errors/tagged-errors";

// ---------------------------------------------------------------------------
// Normalised cross-registry shapes
// ---------------------------------------------------------------------------

export const BUSINESS_REGISTRY_SLUGS = [
  "ares",
  "brreg",
  "prh",
  "recherche-entreprises",
] as const;
export type BusinessRegistrySlug = (typeof BUSINESS_REGISTRY_SLUGS)[number];

export type BusinessRegistryAddress = {
  line1: string | null;
  line2: string | null;
  postalCode: string | null;
  city: string | null;
  region: string | null;
  country: string | null;
  textAddress: string | null;
};

export type BusinessRegistryHit = {
  registry: BusinessRegistrySlug;
  id: string;
  name: string;
  legalForm: string | null;
  address: BusinessRegistryAddress | null;
  registryUrl: string;
  /**
   * Adapter-specific enrichment beyond the cross-registry baseline.
   * Present on canonical-ID lookups (where the upstream returns the
   * full entity) and absent on name-search hits (where the upstream
   * only returns a thin row). The chat tool surfaces `details` to the
   * model so it can answer questions about statutory bodies, court
   * files, industry codes, etc. — the cross-registry top-level fields
   * stay stable for callers that only need the baseline.
   *
   * Discriminated on `registry` so per-adapter narrowing yields the
   * typed upstream payload. Add a new branch each time a registry
   * adapter lands; the `BusinessRegistrySlug` union forces the
   * compiler to flag the missing case.
   */
  details?: BusinessRegistryHitDetails;
};

export type BusinessRegistryHitDetails =
  | { registry: "ares"; company: AresCompany }
  | { registry: "brreg"; entity: BrregEntity }
  | { registry: "prh"; company: PrhCompany }
  | { registry: "recherche-entreprises"; company: RechercheEntreprisesCompany };

export type RegistryLookupResponse =
  | {
      type: "lookup";
      registry: BusinessRegistrySlug;
      hit: BusinessRegistryHit | null;
    }
  | {
      type: "search";
      registry: BusinessRegistrySlug;
      hits: BusinessRegistryHit[];
    };

// ---------------------------------------------------------------------------
// Per-registry handler shape
// ---------------------------------------------------------------------------

export type RegistryHandler = {
  /** Slug as it appears in the catalogue + the REST `?registry=` param. */
  slug: BusinessRegistrySlug;
  /**
   * ISO country code the registry covers. The chat tool uses this to
   * route a user-supplied jurisdiction to the right adapter
   * (CZ → ares, NO → brreg, ...).
   */
  country: CountryCode;
  /** Catalog slug used by `isNativeToolEnabledForOrg`. */
  nativeToolSlug: string;
  /**
   * True when the trimmed input has the *shape* of the registry's
   * canonical ID — e.g. eight digits for a Czech IČO, nine digits for
   * a Norwegian orgnr. Intentionally a cheap, permissive structural
   * check, NOT a full validator. Semantic validation (checksums,
   * country prefixes, etc.) belongs in `lookup`; bad-checksum inputs
   * surface as a `*ValidationError` → mapped to HTTP 400 by `mapError`.
   * Returning `false` here would fall through to `search`, which
   * silently swallows malformed IDs as empty name-search results.
   */
  isCanonicalId: (input: string) => boolean;
  /** Lookup by canonical ID. */
  lookup: (input: string) => Promise<BusinessRegistryHit | null>;
  /**
   * Search by name. `null` when the upstream registry has no
   * name-search endpoint (e.g. KRS). Callers attempting name search
   * against such a registry get a 400. The optional `limit` is
   * forwarded to the underlying adapter so the same value
   * controls both the upstream page size and the returned slice.
   */
  search:
    | ((
        input: string,
        options?: { limit?: number },
      ) => Promise<BusinessRegistryHit[]>)
    | null;
  /** Translate per-registry tagged errors into HandlerError. */
  mapError: (error: unknown) => HandlerError | null;
};

// ---------------------------------------------------------------------------
// ARES (Czech Republic)
// ---------------------------------------------------------------------------

const aresAddressToHit = (
  address: AresAddress | null,
): BusinessRegistryAddress | null => {
  if (!address) {
    return null;
  }
  const houseSegment = [
    address.houseNumber,
    address.orientationNumber
      ? `/${address.orientationNumber}${address.orientationLetter ?? ""}`
      : null,
  ]
    .filter(Boolean)
    .join("");
  // ARES sometimes returns the place name in `municipalityPart` and
  // leaves `street` empty — typical for small municipalities without
  // numbered street names. Falling back keeps the registered seat
  // visible in the contact form's first address line.
  const streetOrLocality = address.street ?? address.municipalityPart;
  const lineParts = [streetOrLocality, houseSegment].filter(Boolean);
  const line1 = lineParts.length > 0 ? lineParts.join(" ") : null;
  // Avoid duplicating municipalityPart in line2 if we already
  // promoted it to line1 above.
  const line2 =
    !address.street && address.municipalityPart
      ? null
      : address.municipalityPart;
  return {
    line1,
    line2,
    postalCode: address.postalCode,
    city: address.municipality,
    region: address.district,
    country: address.country,
    textAddress: address.textAddress,
  };
};

const aresCompanyToHit = (company: AresCompany): BusinessRegistryHit => ({
  registry: "ares",
  id: company.ico,
  name: company.name,
  legalForm: company.legalForm,
  address: aresAddressToHit(company.address),
  registryUrl: company.registryUrl,
  // Carry the VR-enriched payload (court file, statutory bodies,
  // acting clause, NACE, …) so chat callers can answer questions the
  // baseline shape cannot — the legacy `ares_lookup_company` tool
  // exposed these directly and the dispatch path must not regress.
  details: { registry: "ares", company },
});

const aresSearchResultToHit = (
  result: AresSearchResult,
): BusinessRegistryHit => ({
  registry: "ares",
  id: result.ico,
  name: result.name,
  legalForm: null,
  address: result.address
    ? {
        line1: null,
        line2: null,
        postalCode: null,
        city: null,
        region: null,
        country: null,
        textAddress: result.address,
      }
    : null,
  registryUrl: `https://ares.gov.cz/ekonomicke-subjekty?ico=${result.ico}`,
});

const mapAresError = (error: unknown): HandlerError | null => {
  if (error instanceof AresValidationError) {
    return new HandlerError({ status: 400, message: error.message });
  }
  if (error instanceof AresTooBroadError) {
    return new HandlerError({
      status: 400,
      message: "Search too broad. Please refine your query.",
    });
  }
  if (error instanceof AresAPIError) {
    return new HandlerError({
      status: 502,
      message: `ARES API error: ${error.message}`,
    });
  }
  if (error instanceof AresRequestError) {
    return new HandlerError({
      status: 502,
      message: `ARES request failed: ${error.message}`,
    });
  }
  return null;
};

const ARES_HANDLER: RegistryHandler = {
  slug: "ares",
  country: "CZ",
  nativeToolSlug: "ares",
  isCanonicalId: (input) => /^\d{8}$/u.test(normalizeIco(input)),
  lookup: async (input) => {
    const company = await lookupByIco(input);
    return company ? aresCompanyToHit(company) : null;
  },
  search: async (input, options) => {
    const results = await searchAresByName(input, options);
    return results.map(aresSearchResultToHit);
  },
  mapError: mapAresError,
};

// ---------------------------------------------------------------------------
// Brreg (Norway)
// ---------------------------------------------------------------------------

const brregEntityToHit = (entity: BrregEntity): BusinessRegistryHit => ({
  registry: "brreg",
  id: entity.orgnr,
  name: entity.name,
  legalForm: entity.legalForm,
  address: entity.businessAddress
    ? {
        line1: entity.businessAddress.street,
        line2: null,
        postalCode: entity.businessAddress.postalCode,
        city: entity.businessAddress.city,
        region: entity.businessAddress.municipality,
        country: entity.businessAddress.country,
        textAddress: entity.businessAddress.textAddress,
      }
    : null,
  registryUrl: entity.registryUrl,
  // Carry postal address, industry codes, employee count, status
  // discriminator, etc. — same rationale as ARES.
  details: { registry: "brreg", entity },
});

const brregSearchResultToHit = (
  result: BrregSearchResult,
): BusinessRegistryHit => ({
  registry: "brreg",
  id: result.orgnr,
  name: result.name,
  legalForm: null,
  address: result.address
    ? {
        line1: null,
        line2: null,
        postalCode: null,
        city: null,
        region: null,
        country: null,
        textAddress: result.address,
      }
    : null,
  registryUrl: `https://virksomhet.brreg.no/nb/oppslag/enheter/${result.orgnr}`,
});

const mapBrregError = (error: unknown): HandlerError | null => {
  if (error instanceof BrregValidationError) {
    return new HandlerError({ status: 400, message: error.message });
  }
  if (error instanceof BrregTooBroadError) {
    return new HandlerError({
      status: 400,
      message: "Search too broad. Please refine your query.",
    });
  }
  if (error instanceof BrregAPIError) {
    return new HandlerError({
      status: 502,
      message: `Brreg API error: ${error.message}`,
    });
  }
  if (error instanceof BrregRequestError) {
    return new HandlerError({
      status: 502,
      message: `Brreg request failed: ${error.message}`,
    });
  }
  return null;
};

const BRREG_HANDLER: RegistryHandler = {
  slug: "brreg",
  country: "NO",
  nativeToolSlug: "brreg",
  isCanonicalId: (input) => /^\d{9}$/u.test(normalizeOrgnr(input)),
  lookup: async (input) => {
    const entity = await lookupByOrgnr(input);
    return entity ? brregEntityToHit(entity) : null;
  },
  search: async (input, options) => {
    const results = await searchBrregByName(input, options);
    return results.map(brregSearchResultToHit);
  },
  mapError: mapBrregError,
};

// ---------------------------------------------------------------------------
// PRH (Finland)
// ---------------------------------------------------------------------------

const prhCompanyToHit = (company: PrhCompany): BusinessRegistryHit => {
  // PRH separates the legal street address (type 1) from the postal
  // address (type 2). Entities that only file a postal address (PO
  // boxes, agent-held mail) leave streetAddress null. Fall back to
  // postalAddress so REST / chat consumers that only read the
  // baseline `address` field do not lose all address information.
  const source = company.streetAddress ?? company.postalAddress;
  return {
    registry: "prh",
    id: company.businessId,
    name: company.name,
    legalForm: company.legalForm,
    address: source
      ? {
          line1: source.street,
          line2: null,
          postalCode: source.postalCode,
          city: source.city,
          region: null,
          country: source.country,
          textAddress: source.textAddress,
        }
      : null,
    registryUrl: company.registryUrl,
    // Surface trade-register membership, status, business line, etc.
    // — the unified chat tool needs more than name+address to answer
    // questions about Finnish entities.
    details: { registry: "prh", company },
  };
};

const prhSearchResultToHit = (
  result: PrhSearchResult,
): BusinessRegistryHit => ({
  registry: "prh",
  id: result.businessId,
  name: result.name,
  legalForm: null,
  address: result.address
    ? {
        line1: null,
        line2: null,
        postalCode: null,
        city: null,
        region: null,
        country: null,
        textAddress: result.address,
      }
    : null,
  // See parse.ts for why this points at the AvoinData JSON endpoint
  // rather than the YTJ web portal: yavain/tarkiste is an internal
  // record key, not the business ID.
  registryUrl: `https://avoindata.prh.fi/opendata-ytj-api/v3/companies?businessId=${encodeURIComponent(result.businessId)}`,
});

const mapPrhError = (error: unknown): HandlerError | null => {
  if (error instanceof PrhValidationError) {
    return new HandlerError({ status: 400, message: error.message });
  }
  if (error instanceof PrhAPIError) {
    return new HandlerError({
      status: 502,
      message: `PRH API error: ${error.message}`,
    });
  }
  if (error instanceof PrhRequestError) {
    return new HandlerError({
      status: 502,
      message: `PRH request failed: ${error.message}`,
    });
  }
  return null;
};

const PRH_HANDLER: RegistryHandler = {
  slug: "prh",
  country: "FI",
  nativeToolSlug: "prh",
  // Shape check only — full MOD-11 validation happens in lookupByBusinessId
  // and surfaces as PrhValidationError → HTTP 400 via mapPrhError. Falling
  // through to search would silently turn a bad-checksum Y-tunnus into an
  // empty name-search result.
  isCanonicalId: (input) => /^\d{7}-\d$/u.test(normalizeBusinessId(input)),
  lookup: async (input) => {
    const company = await lookupByBusinessId(input);
    return company ? prhCompanyToHit(company) : null;
  },
  search: async (input, options) => {
    const results = await searchPrhByName(input, options);
    return results.map(prhSearchResultToHit);
  },
  mapError: mapPrhError,
};

// ---------------------------------------------------------------------------
// recherche-entreprises (France)
// ---------------------------------------------------------------------------

// Upstream is keyed by unité légale (SIREN); on SIRET lookups the
// adapter additionally surfaces the matched etablissement. Prefer the
// matched etablissement's address when present so SIRET callers see
// the specific establishment they asked about; fall back to the head
// office (siège) for SIREN lookups.
const rechercheEntreprisesCompanyToHit = (
  company: RechercheEntreprisesCompany,
): BusinessRegistryHit => {
  const source = company.matchedEstablishment ?? company.headOffice;
  return {
    registry: "recherche-entreprises",
    id: company.matchedEstablishment?.siret ?? company.siren,
    name: company.name,
    legalForm: company.legalFormCode,
    address: source?.address
      ? {
          line1: source.address.street,
          line2: null,
          postalCode: source.address.postalCode,
          city: source.address.city,
          region: null,
          country: source.address.country,
          textAddress: source.address.textAddress,
        }
      : null,
    registryUrl: company.registryUrl,
    // Carry directors, head office, matched establishment, etc. — the
    // unified chat tool needs more than name+address to answer
    // questions about French entities.
    details: { registry: "recherche-entreprises", company },
  };
};

const rechercheEntreprisesSearchResultToHit = (
  result: RechercheEntreprisesSearchResult,
): BusinessRegistryHit => ({
  registry: "recherche-entreprises",
  id: result.siren,
  name: result.name,
  legalForm: null,
  address: result.address
    ? {
        line1: null,
        line2: null,
        postalCode: null,
        city: null,
        region: null,
        country: null,
        textAddress: result.address,
      }
    : null,
  registryUrl: `https://annuaire-entreprises.data.gouv.fr/entreprise/${encodeURIComponent(result.siren)}`,
});

const mapRechercheEntreprisesError = (error: unknown): HandlerError | null => {
  if (error instanceof RechercheEntreprisesValidationError) {
    return new HandlerError({ status: 400, message: error.message });
  }
  if (error instanceof RechercheEntreprisesAPIError) {
    return new HandlerError({
      status: 502,
      message: `recherche-entreprises API error: ${error.message}`,
    });
  }
  if (error instanceof RechercheEntreprisesRequestError) {
    return new HandlerError({
      status: 502,
      message: `recherche-entreprises request failed: ${error.message}`,
    });
  }
  return null;
};

const RECHERCHE_ENTREPRISES_HANDLER: RegistryHandler = {
  slug: "recherche-entreprises",
  country: "FR",
  nativeToolSlug: "recherche-entreprises",
  // Shape check only — Luhn validation happens in lookupBy{Siren,Siret}
  // and surfaces as RechercheEntreprisesValidationError → HTTP 400.
  // Falling through to search would silently turn a bad-checksum
  // SIREN/SIRET into an empty name-search result.
  isCanonicalId: (input) => hasRechercheEntreprisesShape(input),
  lookup: async (input) => {
    const normalized = normalizeSiren(input);
    // Dispatch by length: 9 = SIREN, 14 = SIRET. The shape check
    // above guarantees one of the two; anything else falls through to
    // name search and never reaches this branch.
    const company =
      normalized.length === 14
        ? await lookupBySiret(normalized)
        : await lookupBySiren(normalized);
    return company ? rechercheEntreprisesCompanyToHit(company) : null;
  },
  search: async (input, options) => {
    const results = await searchRechercheEntreprisesByName(input, options);
    return results.map(rechercheEntreprisesSearchResultToHit);
  },
  mapError: mapRechercheEntreprisesError,
};

// ---------------------------------------------------------------------------
// Registry table + lookups
// ---------------------------------------------------------------------------

export const BUSINESS_REGISTRY_DISPATCH: Record<
  BusinessRegistrySlug,
  RegistryHandler
> = {
  ares: ARES_HANDLER,
  brreg: BRREG_HANDLER,
  prh: PRH_HANDLER,
  "recherche-entreprises": RECHERCHE_ENTREPRISES_HANDLER,
};

const HANDLERS_BY_COUNTRY: ReadonlyMap<CountryCode, RegistryHandler> = new Map(
  Object.values(BUSINESS_REGISTRY_DISPATCH).map((handler) => [
    handler.country,
    handler,
  ]),
);

/**
 * Look up the registry handler for a given country code, if Stella
 * has an adapter shipped for it. The chat tool uses this to dispatch
 * from a user-facing jurisdiction (CZ, NO) to the underlying adapter.
 */
export const getRegistryHandlerByCountry = (
  country: CountryCode,
): RegistryHandler | undefined => HANDLERS_BY_COUNTRY.get(country);

/**
 * Run the dispatch flow for a registry handler: detect lookup vs.
 * search by canonical-ID shape, run the upstream call, normalise the
 * result onto `BusinessRegistryHit`. Returns either a
 * `RegistryLookupResponse` or a `HandlerError` (rather than throwing)
 * so callers can route the failure mode without their own try/catch
 * boilerplate.
 *
 * @returns `RegistryLookupResponse` on success; `HandlerError` for
 *   validation failures, unsupported name-search, or upstream errors.
 */
export const executeRegistryLookup = async ({
  handler,
  query,
  limit,
}: {
  handler: RegistryHandler;
  query: string;
  /**
   * Forwarded to the adapter's name-search call. Ignored on the
   * lookup path (canonical-ID resolution always returns at most one
   * hit). Per-adapter clamps still apply (e.g. Brreg caps each page
   * at 100); a passed value larger than the adapter's max is
   * silently clamped to the adapter's max.
   */
  limit?: number;
}): Promise<RegistryLookupResponse | HandlerError> => {
  const trimmed = query.trim();
  if (trimmed.length === 0) {
    return new HandlerError({
      status: 400,
      message: "'query' must not be empty",
    });
  }

  const isLookup = handler.isCanonicalId(trimmed);
  const searchFn = handler.search;
  if (!isLookup && !searchFn) {
    return new HandlerError({
      status: 400,
      message: `Registry '${handler.slug}' does not support name search; provide a canonical identifier`,
    });
  }

  try {
    if (isLookup) {
      const hit = await handler.lookup(trimmed);
      return { type: "lookup", registry: handler.slug, hit };
    }
    if (!searchFn) {
      panic("searchFn must be defined when !isLookup reaches here");
    }
    const hits = await searchFn(
      trimmed,
      limit === undefined ? undefined : { limit },
    );
    return { type: "search", registry: handler.slug, hits };
  } catch (error) {
    const mapped = handler.mapError(error);
    if (mapped) {
      return mapped;
    }
    return new HandlerError({
      status: 500,
      message: `Registry '${handler.slug}' lookup failed`,
      cause: error,
    });
  }
};
