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
  CompaniesHouseAPIError,
  CompaniesHouseAuthError,
  type CompaniesHouseCompany,
  CompaniesHouseRequestError,
  type CompaniesHouseSearchResult,
  CompaniesHouseValidationError,
  lookupByCompanyNumber,
  normalizeCompanyNumber,
  searchByName as searchCompaniesHouseByName,
} from "@stll/business-registries/companies-house";
import {
  EdgarAPIError,
  type EdgarCompany,
  EdgarRequestError,
  EdgarValidationError,
  lookupByCik,
  normalizeCik,
} from "@stll/business-registries/edgar";
import {
  GcisAPIError,
  type GcisCompany,
  GcisRequestError,
  type GcisSearchResult,
  GcisValidationError,
  lookupByTaxId,
  normalizeTaxId,
  searchByName as searchGcisByName,
} from "@stll/business-registries/gcis";
import {
  KrsAPIError,
  type KrsEntity,
  KrsRequestError,
  KrsValidationError,
  lookupByKrsNumber,
  normalizeKrsNumber,
} from "@stll/business-registries/krs";
import {
  OrsrAPIError,
  type OrsrAddress,
  type OrsrCompany,
  OrsrRequestError,
  type OrsrSearchResult,
  OrsrValidationError,
  lookupByIco as lookupOrsrByIco,
  normalizeIco as normalizeOrsrIco,
  searchByName as searchOrsrByName,
} from "@stll/business-registries/orsr";
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
import {
  isKnownVatCountry,
  parseVatNumber,
  validateVat,
  type ViesValidation,
  ViesAPIError,
  ViesRequestError,
  ViesValidationError,
} from "@stll/business-registries/vies";
import type { CountryCode } from "@stll/country-codes";

import { HandlerError } from "@/api/lib/errors/tagged-errors";

// ---------------------------------------------------------------------------
// Jurisdiction codes
//
// VIES is an EU-wide pseudo-jurisdiction, not a real country. We widen
// the registry jurisdiction type to `CountryCode | "EU"` so the unified
// dispatch + chat tool can route to the VIES adapter without polluting
// `CountryCode` (which is structurally the ISO 3166-1 alpha-2 set).
// ---------------------------------------------------------------------------

export const EU_PSEUDO_JURISDICTION = "EU" as const;
export type RegistryJurisdictionCode =
  | CountryCode
  | typeof EU_PSEUDO_JURISDICTION;

// ---------------------------------------------------------------------------
// Normalised cross-registry shapes
// ---------------------------------------------------------------------------

export const BUSINESS_REGISTRY_SLUGS = [
  "ares",
  "brreg",
  "companies-house",
  "edgar",
  "gcis",
  "krs",
  "orsr",
  "prh",
  "recherche-entreprises",
  "vies",
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
  | { registry: "companies-house"; company: CompaniesHouseCompany }
  | { registry: "edgar"; company: EdgarCompany }
  | { registry: "gcis"; company: GcisCompany }
  | { registry: "krs"; entity: KrsEntity }
  | { registry: "orsr"; company: OrsrCompany }
  | { registry: "prh"; company: PrhCompany }
  | { registry: "recherche-entreprises"; company: RechercheEntreprisesCompany }
  | { registry: "vies"; validation: ViesValidation };

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
   * Jurisdiction the registry covers. The chat tool uses this to
   * route a user-supplied jurisdiction to the right adapter
   * (CZ → ares, NO → brreg, EU → vies, ...).
   *
   * Normally an ISO 3166-1 alpha-2 country code. The special "EU"
   * value is reserved for EU-wide pseudo-jurisdictions (currently
   * just VIES, which validates VAT numbers across all member states
   * from a single endpoint).
   */
  country: RegistryJurisdictionCode;
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
  /** Deployment-level gate for adapters that require server config. */
  isDeployAvailable: () => boolean;
  /** Translate per-registry tagged errors into HandlerError. */
  mapError: (error: unknown) => HandlerError | null;
};

const isAlwaysDeployAvailable = (): boolean => true;

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
  isDeployAvailable: isAlwaysDeployAvailable,
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
  isDeployAvailable: isAlwaysDeployAvailable,
  mapError: mapBrregError,
};

// ---------------------------------------------------------------------------
// Companies House (United Kingdom)
// ---------------------------------------------------------------------------

const companiesHouseCompanyToHit = (
  company: CompaniesHouseCompany,
): BusinessRegistryHit => ({
  registry: "companies-house",
  id: company.companyNumber,
  name: company.name,
  legalForm: company.type,
  address: company.registeredOfficeAddress
    ? {
        line1:
          [
            company.registeredOfficeAddress.premises,
            company.registeredOfficeAddress.addressLine1,
          ]
            .filter(Boolean)
            .join(" ") || null,
        line2: company.registeredOfficeAddress.addressLine2,
        postalCode: company.registeredOfficeAddress.postalCode,
        city: company.registeredOfficeAddress.locality,
        region: company.registeredOfficeAddress.region,
        country: company.registeredOfficeAddress.country,
        textAddress: company.registeredOfficeAddress.textAddress,
      }
    : null,
  registryUrl: company.registryUrl,
  // Carry status discriminator, SIC codes, accounts / confirmation
  // statement timing, previous names, etc. so chat callers can answer
  // questions the baseline shape cannot.
  details: { registry: "companies-house", company },
});

const companiesHouseSearchResultToHit = (
  result: CompaniesHouseSearchResult,
): BusinessRegistryHit => ({
  registry: "companies-house",
  id: result.companyNumber,
  name: result.name,
  legalForm: result.type,
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
  registryUrl: result.registryUrl,
});

const mapCompaniesHouseError = (error: unknown): HandlerError | null => {
  if (error instanceof CompaniesHouseValidationError) {
    return new HandlerError({ status: 400, message: error.message });
  }
  if (error instanceof CompaniesHouseAuthError) {
    // Auth failure is an operator-configuration bug, not something
    // the end user can fix. Map to 502 with the upstream-derived
    // message rather than a 401 the caller cannot act on.
    return new HandlerError({
      status: 502,
      message: `UK Companies House API key not configured: ${error.message}`,
    });
  }
  if (error instanceof CompaniesHouseAPIError) {
    return new HandlerError({
      status: 502,
      message: `UK Companies House API error: ${error.message}`,
    });
  }
  if (error instanceof CompaniesHouseRequestError) {
    return new HandlerError({
      status: 502,
      message: `UK Companies House request failed: ${error.message}`,
    });
  }
  return null;
};

// The handler resolves the Companies House API key at call time
// rather than at module load. Reading `process.env` directly here
// (instead of via the centralised `env` import) keeps `dispatch.ts`
// free of side effects at import time — the chat tool catalogue imports
// this module from contexts that don't run full env validation
// (workers, scripts, tests). The env schema in `apps/api/src/env.ts`
// still declares `COMPANIES_HOUSE_API_KEY` so the API server boot path
// validates it like the rest of config.
const COMPANIES_HOUSE_API_KEY_ENV_VAR = "COMPANIES_HOUSE_API_KEY";

export const isCompaniesHouseDeployAvailable = (): boolean =>
  Boolean(process.env[COMPANIES_HOUSE_API_KEY_ENV_VAR]?.trim());

const requireCompaniesHouseApiKey = (): string => {
  const apiKey = process.env[COMPANIES_HOUSE_API_KEY_ENV_VAR]?.trim();
  if (!apiKey) {
    throw new CompaniesHouseAuthError(
      "COMPANIES_HOUSE_API_KEY is not configured. Get a free API key at https://developer.company-information.service.gov.uk and set the env var.",
    );
  }
  return apiKey;
};

const COMPANIES_HOUSE_HANDLER: RegistryHandler = {
  slug: "companies-house",
  country: "GB",
  nativeToolSlug: "companies-house",
  // SHAPE-only: matches numeric CRNs (E&W), two-letter-prefix CRNs
  // (SC, OC, NI, FC, …), and the pre-partition NI `R0` outlier where
  // the `0` is part of the prefix code rather than the sequence. Full
  // structural validation runs in lookupByCompanyNumber and surfaces
  // as CompaniesHouseValidationError → HTTP 400.
  isCanonicalId: (input) =>
    /^(?:R0\d{6}|[A-Z]{2}\d{6}|\d{8})$/u.test(normalizeCompanyNumber(input)),
  lookup: async (input) => {
    const company = await lookupByCompanyNumber(input, {
      apiKey: requireCompaniesHouseApiKey(),
    });
    return company ? companiesHouseCompanyToHit(company) : null;
  },
  search: async (input, options) => {
    const results = await searchCompaniesHouseByName(
      input,
      { apiKey: requireCompaniesHouseApiKey() },
      options,
    );
    return results.map(companiesHouseSearchResultToHit);
  },
  isDeployAvailable: isCompaniesHouseDeployAvailable,
  mapError: mapCompaniesHouseError,
};

// ---------------------------------------------------------------------------
// SEC EDGAR (United States)
// ---------------------------------------------------------------------------

const edgarPickAddress = (
  company: EdgarCompany,
): BusinessRegistryAddress | null => {
  // Prefer the business address; fall back to mailing so the contact
  // form always gets something for active issuers.
  const address = company.addresses.business ?? company.addresses.mailing;
  if (!address) {
    return null;
  }
  return {
    line1: address.street,
    line2: null,
    postalCode: address.postalCode,
    city: address.city,
    region: address.region,
    country: address.country,
    textAddress: address.textAddress,
  };
};

const edgarCompanyToHit = (company: EdgarCompany): BusinessRegistryHit => ({
  registry: "edgar",
  id: company.cik,
  name: company.name,
  // EDGAR has no notion of legal form on the submissions endpoint;
  // the closest field is SIC (industry classification), which is not
  // a legal form. Leave null instead of overloading the field.
  legalForm: null,
  address: edgarPickAddress(company),
  registryUrl: company.registryUrl,
  // Carry tickers, exchanges, recent filings, status discriminator
  // and former names so chat callers can answer questions the
  // cross-registry baseline can't express.
  details: { registry: "edgar", company },
});

const mapEdgarError = (error: unknown): HandlerError | null => {
  if (error instanceof EdgarValidationError) {
    return new HandlerError({ status: 400, message: error.message });
  }
  if (error instanceof EdgarAPIError) {
    return new HandlerError({
      status: 502,
      message: `SEC EDGAR API error: ${error.message}`,
    });
  }
  if (error instanceof EdgarRequestError) {
    return new HandlerError({
      status: 502,
      message: `SEC EDGAR request failed: ${error.message}`,
    });
  }
  return null;
};

// The handler resolves the SEC-mandated User-Agent at call time
// rather than at module load. Reading `process.env` directly here
// (instead of via the centralised `env` import) keeps `dispatch.ts`
// free of side effects at import time — important because the chat
// tool catalogue imports this module from contexts that don't run
// full env validation (workers, scripts, tests). The env schema in
// `apps/api/src/env.ts` still declares `EDGAR_USER_AGENT` so the
// API server boot path validates it like the rest of config.
const EDGAR_USER_AGENT_ENV_VAR = "EDGAR_USER_AGENT";

export const isEdgarDeployAvailable = (): boolean =>
  Boolean(process.env[EDGAR_USER_AGENT_ENV_VAR]?.trim());

const requireEdgarUserAgent = (): string => {
  const userAgent = process.env[EDGAR_USER_AGENT_ENV_VAR]?.trim();
  if (!userAgent) {
    throw new EdgarValidationError(
      "EDGAR_USER_AGENT is not configured. Set it to '<App name> <contact@email>'; the SEC returns 403 without one.",
    );
  }
  return userAgent;
};

const EDGAR_HANDLER: RegistryHandler = {
  slug: "edgar",
  country: "US",
  nativeToolSlug: "edgar",
  // SHAPE-only: 1-10 digits after stripping the optional zero
  // padding. Semantic validation (e.g. the reserved zero CIK) lives
  // in the adapter and surfaces as EdgarValidationError -> HTTP 400.
  isCanonicalId: (input) => /^\d{1,10}$/u.test(normalizeCik(input)),
  lookup: async (input) => {
    const company = await lookupByCik(input, {
      userAgent: requireEdgarUserAgent(),
    });
    return company ? edgarCompanyToHit(company) : null;
  },
  // The cgi-bin EDGAR name search returns Atom XML and is heavy to
  // parse for the first slice. Surface "canonical-ID only" cleanly
  // via the existing null-search path; name search lands in a follow-up.
  search: null,
  isDeployAvailable: isEdgarDeployAvailable,
  mapError: mapEdgarError,
};

// ---------------------------------------------------------------------------
// GCIS (Taiwan)
// ---------------------------------------------------------------------------

const gcisCompanyToHit = (company: GcisCompany): BusinessRegistryHit => ({
  registry: "gcis",
  id: company.taxId,
  name: company.name,
  // GCIS exposes the registering authority (e.g. 商業發展署 / city
  // government) rather than a legal-form descriptor; we leave
  // legalForm null at the cross-registry surface and surface the
  // registering authority via the `details.company` payload.
  legalForm: null,
  // GCIS reports the registered seat as a single free-form Chinese
  // string with no structured atoms (no separate postal code, city,
  // or region fields). Mirror that to `textAddress` instead of
  // guessing structure that the upstream does not provide.
  address: company.location
    ? {
        line1: null,
        line2: null,
        postalCode: null,
        city: null,
        region: null,
        country: "TW",
        textAddress: company.location,
      }
    : null,
  registryUrl: company.registryUrl,
  // Carry capital, responsible person, suspension lifecycle, ROC +
  // Gregorian dates so chat callers can answer the questions the
  // baseline shape cannot — same rationale as ARES / Brreg.
  details: { registry: "gcis", company },
});

const gcisSearchResultToHit = (
  result: GcisSearchResult,
): BusinessRegistryHit => ({
  registry: "gcis",
  id: result.taxId,
  name: result.name,
  legalForm: null,
  address: result.location
    ? {
        line1: null,
        line2: null,
        postalCode: null,
        city: null,
        region: null,
        country: "TW",
        textAddress: result.location,
      }
    : null,
  // See gcis/parse.ts for why this points at the dataset API call:
  // GCIS does not host a stable per-entity HTML page; findbiz.nat.gov.tw
  // uses session-bound keys that 404 once the session expires.
  registryUrl: `https://data.gcis.nat.gov.tw/od/data/api/5F64D864-61CB-4D0D-8AD9-492047CC1EA6?$format=json&$filter=Business_Accounting_NO%20eq%20%27${encodeURIComponent(result.taxId)}%27`,
});

const mapGcisError = (error: unknown): HandlerError | null => {
  if (error instanceof GcisValidationError) {
    return new HandlerError({ status: 400, message: error.message });
  }
  if (error instanceof GcisAPIError) {
    return new HandlerError({
      status: 502,
      message: `GCIS API error: ${error.message}`,
    });
  }
  if (error instanceof GcisRequestError) {
    return new HandlerError({
      status: 502,
      message: `GCIS request failed: ${error.message}`,
    });
  }
  return null;
};

const GCIS_HANDLER: RegistryHandler = {
  slug: "gcis",
  country: "TW",
  nativeToolSlug: "gcis",
  // Shape check only — full MoF-checksum validation runs in
  // lookupByTaxId and surfaces as GcisValidationError → HTTP 400.
  // Falling through to search would silently turn a bad-checksum
  // tongbian into an empty name-search result.
  isCanonicalId: (input) => /^\d{8}$/u.test(normalizeTaxId(input)),
  lookup: async (input) => {
    const company = await lookupByTaxId(input);
    return company ? gcisCompanyToHit(company) : null;
  },
  search: async (input, options) => {
    const results = await searchGcisByName(input, options);
    return results.map(gcisSearchResultToHit);
  },
  isDeployAvailable: isAlwaysDeployAvailable,
  mapError: mapGcisError,
};

// ---------------------------------------------------------------------------
// ORSR (Slovakia)
// ---------------------------------------------------------------------------

const orsrAddressToHit = (
  address: OrsrAddress | null,
): BusinessRegistryAddress | null => {
  if (!address) {
    return null;
  }
  return {
    line1: address.street,
    line2: null,
    postalCode: address.postalCode,
    city: address.city,
    region: null,
    country: address.country,
    textAddress: address.textAddress,
  };
};

const orsrCompanyToHit = (company: OrsrCompany): BusinessRegistryHit => ({
  registry: "orsr",
  id: company.ico,
  name: company.name,
  legalForm: company.legalForm,
  address: orsrAddressToHit(company.address),
  registryUrl: company.registryUrl,
  // Carry the full extract payload — Slovak corporate-law work needs
  // statutory bodies, stakeholders, court file, and acting clause; the
  // baseline cross-registry shape only surfaces name + address.
  details: { registry: "orsr", company },
});

const orsrSearchResultToHit = (
  result: OrsrSearchResult,
): BusinessRegistryHit => ({
  registry: "orsr",
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
  // The search row omits the trade-register file reference needed to
  // construct the canonical Subjekt deep link. Fall back to the
  // public-search page keyed on the IČO so the user still has a
  // verifiable link to the registry.
  registryUrl: `https://sluzby.orsr.sk/vyhladavanie-podla-ico.aspx?lan=sk&ico=${encodeURIComponent(result.ico)}`,
});

const mapOrsrError = (error: unknown): HandlerError | null => {
  if (error instanceof OrsrValidationError) {
    return new HandlerError({ status: 400, message: error.message });
  }
  if (error instanceof OrsrAPIError) {
    return new HandlerError({
      status: 502,
      message: `ORSR API error: ${error.message}`,
    });
  }
  if (error instanceof OrsrRequestError) {
    return new HandlerError({
      status: 502,
      message: `ORSR request failed: ${error.message}`,
    });
  }
  return null;
};

const ORSR_HANDLER: RegistryHandler = {
  slug: "orsr",
  country: "SK",
  nativeToolSlug: "orsr",
  // Shape check only — full MOD-11 validation happens in lookupByIco
  // and surfaces as OrsrValidationError → HTTP 400 via mapOrsrError.
  // Falling through to search would silently turn a bad-checksum IČO
  // into an empty name-search result.
  isCanonicalId: (input) => /^\d{8}$/u.test(normalizeOrsrIco(input)),
  lookup: async (input) => {
    const company = await lookupOrsrByIco(input);
    return company ? orsrCompanyToHit(company) : null;
  },
  search: async (input, options) => {
    const results = await searchOrsrByName(input, options);
    return results.map(orsrSearchResultToHit);
  },
  isDeployAvailable: isAlwaysDeployAvailable,
  mapError: mapOrsrError,
};

// ---------------------------------------------------------------------------
// KRS (Poland)
// ---------------------------------------------------------------------------

const krsEntityToHit = (entity: KrsEntity): BusinessRegistryHit => ({
  registry: "krs",
  id: entity.krsNumber,
  name: entity.name,
  legalForm: entity.legalForm,
  address: entity.address
    ? {
        line1: entity.address.street,
        line2: null,
        postalCode: entity.address.postalCode,
        city: entity.address.city,
        // KRS files an administrative seat (wojewodztwo / powiat /
        // gmina) separately from the postal address. We surface the
        // voivodeship here because it's the cross-cutting region
        // identifier callers expect; the full seat travels inside
        // `details` for chat callers that need finer granularity.
        region: entity.registeredSeat?.voivodeship ?? null,
        country: entity.address.country,
        textAddress: entity.address.textAddress,
      }
    : null,
  registryUrl: entity.registryUrl,
  // Surface identifiers (NIP / REGON), registered seat, lifecycle
  // status, and contact channels — the chat tool needs more than
  // name + address to answer questions about Polish entities.
  details: { registry: "krs", entity },
});

const mapKrsError = (error: unknown): HandlerError | null => {
  if (error instanceof KrsValidationError) {
    return new HandlerError({ status: 400, message: error.message });
  }
  if (error instanceof KrsAPIError) {
    return new HandlerError({
      status: 502,
      message: `KRS API error: ${error.message}`,
    });
  }
  if (error instanceof KrsRequestError) {
    return new HandlerError({
      status: 502,
      message: `KRS request failed: ${error.message}`,
    });
  }
  return null;
};

const KRS_HANDLER: RegistryHandler = {
  slug: "krs",
  country: "PL",
  nativeToolSlug: "krs",
  // Shape check only — full 10-digit validation happens in
  // lookupByKrsNumber and surfaces as KrsValidationError → HTTP 400
  // via mapKrsError. Falling through to search would silently turn a
  // malformed KRS number into "unsupported name search" (KRS has no
  // name endpoint), which is a worse error message for the user.
  isCanonicalId: (input) => /^\d{10}$/u.test(normalizeKrsNumber(input)),
  lookup: async (input) => {
    const entity = await lookupByKrsNumber(input);
    return entity ? krsEntityToHit(entity) : null;
  },
  // KRS has no public name-search endpoint. Callers attempting a
  // name search get the "Registry 'krs' does not support name
  // search" 400 from `executeRegistryLookup`. Name → KRS resolution
  // is a separate REGON BIR1 / Biała Lista slice slated for a
  // follow-up PR.
  search: null,
  isDeployAvailable: isAlwaysDeployAvailable,
  mapError: mapKrsError,
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

// ---------------------------------------------------------------------------
// VIES (EU-wide VAT validation)
//
// Special-case: VIES is not a per-country business registry. The input
// already carries the 2-letter country prefix (e.g. "DE143593636"),
// so the handler's jurisdiction is the synthetic "EU" pseudo-code and
// `isCanonicalId` accepts any VAT-shaped input.
//
// There is no name-search endpoint: VIES validates a fully-qualified
// VAT number and that is it. The handler's `search` is null so the
// dispatch layer surfaces a 400 with a useful message rather than
// silently returning an empty list.
// ---------------------------------------------------------------------------

const VIES_HOMEPAGE = "https://ec.europa.eu/taxation_customs/vies/";

const viesValidationToHit = (
  validation: ViesValidation,
): BusinessRegistryHit => {
  const fullVat = `${validation.vatNumber.country}${validation.vatNumber.vat}`;
  return {
    registry: "vies",
    id: fullVat,
    // Fall back to the VAT itself when the member state suppresses
    // trader data (DE, ES, AT, …) so callers always have something
    // to render in the name slot.
    name: validation.name ?? fullVat,
    legalForm: null,
    address: validation.address
      ? {
          line1: null,
          line2: null,
          postalCode: null,
          city: null,
          region: null,
          country: validation.vatNumber.country,
          textAddress: validation.address,
        }
      : null,
    registryUrl: VIES_HOMEPAGE,
    // Carry the structured validation so the chat model can answer
    // "is VAT DE143593636 valid?" with the registered name + address
    // and the timestamp VIES stamped.
    details: { registry: "vies", validation },
  };
};

const mapViesError = (error: unknown): HandlerError | null => {
  if (error instanceof ViesValidationError) {
    return new HandlerError({ status: 400, message: error.message });
  }
  if (error instanceof ViesAPIError) {
    return new HandlerError({
      status: 502,
      message: `VIES API error: ${error.message}`,
    });
  }
  if (error instanceof ViesRequestError) {
    return new HandlerError({
      status: 502,
      message: `VIES request failed: ${error.message}`,
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
  isDeployAvailable: isAlwaysDeployAvailable,
  mapError: mapPrhError,
};

const VIES_HANDLER: RegistryHandler = {
  slug: "vies",
  country: EU_PSEUDO_JURISDICTION,
  nativeToolSlug: "vies",
  // Shape check only — accept inputs whose prefix matches a known
  // VAT country (`isKnownVatCountry` includes historical members
  // like GB) followed by ≥2 VAT characters and at least one digit
  // (Romanian VAT numbers can be as short as 2 digits, e.g. `RO12`).
  // Without the prefix whitelist and digit check, a plain name like
  // `Deutsche Bank` would parse as prefix `DE` + VAT `UTSCHEBANK`
  // and route to the lookup path, surfacing a confusing VAT-format
  // error instead of the intended "name search not supported" 400.
  // Removed participants (GB) still pass the shape check; the lookup
  // handler owns their tailored `ViesValidationError`.
  isCanonicalId: (input) => {
    const parsed = parseVatNumber(input);
    if (!parsed) {
      return false;
    }
    if (!isKnownVatCountry(parsed.country)) {
      return false;
    }
    return /[0-9]/u.test(parsed.vat) && /^[A-Z0-9+*]{2,}$/u.test(parsed.vat);
  },
  lookup: async (input) => {
    const validation = await validateVat(input);
    return viesValidationToHit(validation);
  },
  // VIES has no name-search endpoint — VAT-only validation. Returning
  // `null` lets `executeRegistryLookup` produce the standard
  // "name-search not supported" 400 instead of guessing.
  search: null,
  isDeployAvailable: isAlwaysDeployAvailable,
  mapError: mapViesError,
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
  isDeployAvailable: isAlwaysDeployAvailable,
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
  "companies-house": COMPANIES_HOUSE_HANDLER,
  edgar: EDGAR_HANDLER,
  gcis: GCIS_HANDLER,
  krs: KRS_HANDLER,
  orsr: ORSR_HANDLER,
  prh: PRH_HANDLER,
  "recherche-entreprises": RECHERCHE_ENTREPRISES_HANDLER,
  vies: VIES_HANDLER,
};

export const getDeployAvailableRegistryHandlers = (): RegistryHandler[] =>
  Object.values(BUSINESS_REGISTRY_DISPATCH).filter((handler) =>
    handler.isDeployAvailable(),
  );

export const isBusinessRegistryNativeToolDeployAvailable = (
  nativeToolSlug: string,
): boolean => {
  const handler = Object.values(BUSINESS_REGISTRY_DISPATCH).find(
    (candidate) => candidate.nativeToolSlug === nativeToolSlug,
  );
  return handler?.isDeployAvailable() ?? true;
};

const HANDLERS_BY_JURISDICTION: ReadonlyMap<
  RegistryJurisdictionCode,
  RegistryHandler
> = new Map(
  Object.values(BUSINESS_REGISTRY_DISPATCH).map((handler) => [
    handler.country,
    handler,
  ]),
);

/**
 * Look up the registry handler for a given jurisdiction code, if
 * Stella has an adapter shipped for it. The chat tool uses this to
 * dispatch from a user-facing jurisdiction (CZ, NO, EU, …) to the
 * underlying adapter.
 *
 * Accepts the special "EU" pseudo-jurisdiction for EU-wide adapters
 * (currently just VIES); see `RegistryJurisdictionCode`.
 */
export const getRegistryHandlerByCountry = (
  country: RegistryJurisdictionCode,
): RegistryHandler | undefined => {
  const handler = getRegistryHandlerDefinitionByCountry(country);
  if (!handler?.isDeployAvailable()) {
    return undefined;
  }
  return handler;
};

export const getRegistryHandlerDefinitionByCountry = (
  country: RegistryJurisdictionCode,
): RegistryHandler | undefined => HANDLERS_BY_JURISDICTION.get(country);

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
