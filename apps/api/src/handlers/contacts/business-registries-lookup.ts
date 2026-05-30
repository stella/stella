import { panic, Result } from "better-result";
import { t } from "elysia";

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

import { isNativeToolEnabledForOrg } from "@/api/handlers/mcp-connectors/catalog-metadata";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

// ---------------------------------------------------------------------------
// Normalised cross-registry shapes
// ---------------------------------------------------------------------------

const BUSINESS_REGISTRY_SLUGS = ["ares", "brreg"] as const;
type BusinessRegistrySlug = (typeof BUSINESS_REGISTRY_SLUGS)[number];

type BusinessRegistryAddress = {
  line1: string | null;
  line2: string | null;
  postalCode: string | null;
  city: string | null;
  region: string | null;
  country: string | null;
  textAddress: string | null;
};

type BusinessRegistryHit = {
  registry: BusinessRegistrySlug;
  id: string;
  name: string;
  legalForm: string | null;
  address: BusinessRegistryAddress | null;
  registryUrl: string;
};

type LookupResponse =
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
// Per-registry dispatch
// ---------------------------------------------------------------------------

type RegistryHandler = {
  /** Catalog slug used by `isNativeToolEnabledForOrg`. */
  nativeToolSlug: string;
  /**
   * True when the trimmed input has the *shape* of the registry's
   * canonical ID — e.g. eight digits for a Czech IČO, nine digits for
   * a Norwegian orgnr. This is intentionally a cheap, permissive
   * structural check, NOT a full validator. Semantic validation
   * (checksums, country prefixes, etc.) belongs in the `lookup`
   * function; bad-checksum inputs surface as a `*ValidationError` →
   * mapped to HTTP 400 by `mapError`. Returning `false` here would
   * fall through to `search`, which silently swallows malformed IDs
   * as empty name-search results — exactly the UX we want to avoid.
   */
  isCanonicalId: (input: string) => boolean;
  /** Lookup by canonical ID. */
  lookup: (input: string) => Promise<BusinessRegistryHit | null>;
  /**
   * Search by name. `null` when the upstream registry has no name-search
   * endpoint (e.g. KRS). The handler returns 400 when callers attempt
   * name search against such a registry.
   */
  search: ((input: string) => Promise<BusinessRegistryHit[]>) | null;
  /** Translate per-registry tagged errors into HandlerError. */
  mapError: (error: unknown) => HandlerError | null;
};

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
  nativeToolSlug: "ares",
  // Shape-only: 8 digits after normalisation. Bad checksums route
  // through lookup and surface as AresValidationError → 400.
  isCanonicalId: (input) => /^\d{8}$/u.test(normalizeIco(input)),
  lookup: async (input) => {
    const company = await lookupByIco(input);
    return company ? aresCompanyToHit(company) : null;
  },
  search: async (input) => {
    const results = await searchAresByName(input);
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
  nativeToolSlug: "brreg",
  // Shape-only: 9 digits after normalisation. MOD-11 violations
  // route through lookup and surface as BrregValidationError → 400.
  isCanonicalId: (input) => /^\d{9}$/u.test(normalizeOrgnr(input)),
  lookup: async (input) => {
    const entity = await lookupByOrgnr(input);
    return entity ? brregEntityToHit(entity) : null;
  },
  search: async (input) => {
    const results = await searchBrregByName(input);
    return results.map(brregSearchResultToHit);
  },
  mapError: mapBrregError,
};

const DISPATCH: Record<BusinessRegistrySlug, RegistryHandler> = {
  ares: ARES_HANDLER,
  brreg: BRREG_HANDLER,
};

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

const querySchema = t.Object({
  registry: t.UnionEnum(BUSINESS_REGISTRY_SLUGS),
  q: t.String({ minLength: 1, maxLength: 256 }),
});

const businessRegistriesLookup = createSafeRootHandler(
  {
    permissions: { workspace: ["read"] },
    query: querySchema,
  },
  async function* ({ query, safeDb, session }) {
    const { registry, q } = query;
    const config = DISPATCH[registry];

    const trimmed = q.trim();
    if (trimmed.length === 0) {
      return Result.err(
        new HandlerError({
          status: 400,
          message: "'q' must not be empty",
        }),
      );
    }

    const settings = yield* Result.await(
      safeDb((tx) =>
        tx.query.organizationSettings.findFirst({
          where: { organizationId: { eq: session.activeOrganizationId } },
          columns: {
            practiceJurisdictions: true,
            nativeToolOverrides: true,
          },
        }),
      ),
    );
    const enabled = isNativeToolEnabledForOrg({
      slug: config.nativeToolSlug,
      practiceJurisdictions: settings?.practiceJurisdictions ?? [],
      nativeToolOverrides: settings?.nativeToolOverrides ?? {},
    });
    if (!enabled) {
      return Result.err(
        new HandlerError({
          status: 403,
          message: `Registry '${registry}' is disabled for this organization`,
        }),
      );
    }

    const isLookup = config.isCanonicalId(trimmed);
    const searchFn = config.search;
    if (!isLookup && !searchFn) {
      return Result.err(
        new HandlerError({
          status: 400,
          message: `Registry '${registry}' does not support name search; provide a canonical identifier`,
        }),
      );
    }

    const result = yield* Result.await(
      Result.tryPromise({
        try: async (): Promise<LookupResponse> => {
          if (isLookup) {
            const hit = await config.lookup(trimmed);
            return { type: "lookup", registry, hit };
          }
          // The `!isLookup && !searchFn` branch above returns early, so
          // by the time we get here `searchFn` is guaranteed defined.
          if (!searchFn) {
            panic("searchFn must be defined when !isLookup reaches here");
          }
          const hits = await searchFn(trimmed);
          return { type: "search", registry, hits };
        },
        catch: (error): HandlerError => {
          const mapped = config.mapError(error);
          if (mapped) {
            return mapped;
          }
          return new HandlerError({
            status: 500,
            message: `Registry '${registry}' lookup failed`,
            cause: error,
          });
        },
      }),
    );

    return Result.ok(result);
  },
);

export default businessRegistriesLookup;
