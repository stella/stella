import { Result } from "better-result";
import * as v from "valibot";

import {
  PUBLIC_CASE_LAW_COUNTRIES,
  publicCaseLawCountry,
} from "@stll/api-contract/case-law-launch-readiness";

import { status } from "@/api/http/status";
import { caseLawPublicReadDb } from "@/api/lib/case-law-public-read-db";
import {
  type NonRedistributableSourcesError,
  readNonRedistributableCaseLawSourceIds,
} from "@/api/lib/case-law/non-redistributable-sources";
import {
  populationCountsCacheVersion,
  readCaseLawPopulationFreshness,
} from "@/api/lib/case-law/population-count-freshness";
import { errorTag } from "@/api/lib/errors/utils";
import { LegalBrowseFacetsError } from "@/api/lib/legal-search/browse-facets";
import { createBrowseFacetsCache } from "@/api/lib/legal-search/browse-facets-cache";
import { isCorpusIndexJurisdiction } from "@/api/lib/legal-search/index-naming";
import { pgFtsBrowseFacets } from "@/api/lib/legal-search/pg-fts-browse-facets";
import {
  readPublicLawCountry,
  tPublicLawCountry,
} from "@/api/lib/legal-search/public-law-country";
import type { LegalBrowseFacets } from "@/api/lib/legal-search/types";
import { LIMITS } from "@/api/lib/limits";
import { logger } from "@/api/lib/observability/logger";

/**
 * Facet counts for the public browse page: which countries, courts and years
 * the corpus holds, and how many decisions each has. Decision transactions
 * maintain these populations independently of the search provider.
 */

export const listDecisionFacetsQuerySchema = v.object({
  country: tPublicLawCountry,
});

type ListDecisionFacetsQuery = v.InferOutput<
  typeof listDecisionFacetsQuerySchema
>;

const FACETS_CACHE_TTL_MS = 5 * 60 * 1000;
const FACETS_CACHE_MAX_ENTRIES = 32;

const EMPTY_FACETS: LegalBrowseFacets = {
  country: [],
  court: [],
  year: [],
  countsFreshness: { status: "unavailable" },
};

const browseFacets = createBrowseFacetsCache({
  load: async (query) => await pgFtsBrowseFacets(query),
  ttlMs: FACETS_CACHE_TTL_MS,
  maxEntries: FACETS_CACHE_MAX_ENTRIES,
});

export const listDecisionFacetsHandler = async ({
  country,
}: ListDecisionFacetsQuery) => {
  const countryRead = readPublicLawCountry(country, {
    domain: "caseLaw",
    admitted: PUBLIC_CASE_LAW_COUNTRIES,
    surface: "search",
  });
  if (countryRead.kind === "unavailable") {
    return countryRead.answer;
  }
  if (countryRead.kind === "unreadable") {
    return status(400, { message: countryRead.message });
  }
  const publicCountry = publicCaseLawCountry(countryRead.country);
  if (publicCountry === null || !isCorpusIndexJurisdiction(publicCountry)) {
    return status(404, { message: "Not Found" });
  }

  return await readBrowseFacets(publicCountry);
};

type BrowseFacetsReadError =
  LegalBrowseFacetsError | NonRedistributableSourcesError;

export type BrowseFacetsUnderPolicyRead = {
  country: string;
  /** Sources whose redistribution is currently revoked; part of the cache key. */
  excludedSourceIds: readonly string[];
};

/**
 * Cached facets for a validated jurisdiction under a source policy the
 * caller already holds, so a reader combining the facets with another
 * policy-scoped read (the corpus status) answers from one policy snapshot.
 * The failure stays a value: the status counts from the country bucket, and
 * a missing bucket must not read as zero.
 */
export const readBrowseFacetsUnderPolicy = async ({
  country,
  excludedSourceIds,
}: BrowseFacetsUnderPolicyRead): Promise<
  Result<LegalBrowseFacets, LegalBrowseFacetsError>
> => {
  const freshness = await Result.tryPromise({
    try: async () => await caseLawPublicReadDb(readCaseLawPopulationFreshness),
    catch: (cause) =>
      new LegalBrowseFacetsError({
        message: "Population freshness read failed",
        cause,
      }),
  });
  if (Result.isError(freshness)) {
    return freshness;
  }
  return await browseFacets({
    jurisdiction: country.toUpperCase(),
    excludedSourceIds,
    populationVersion: populationCountsCacheVersion(freshness.value),
    limit: LIMITS.caseLawFacetLimit,
  });
};

/** The same facets under the current source policy. */
const readBrowseFacetsResult = async (
  country: string,
): Promise<Result<LegalBrowseFacets, BrowseFacetsReadError>> => {
  // Read ahead of the cache, not inside it: source policy is an input to the
  // answer, so a revocation has to change the cache key. Reading it behind the
  // cache would keep a revoked source's buckets public for a whole window.
  // Failing closed here is deliberate — no facets beats stale ones.
  const excludedSourceIds = await readNonRedistributableCaseLawSourceIds();
  if (Result.isError(excludedSourceIds)) {
    return excludedSourceIds;
  }
  return await readBrowseFacetsUnderPolicy({
    country,
    excludedSourceIds: excludedSourceIds.value,
  });
};

/**
 * The same facets, degraded to an empty set on any failure: facets are
 * navigation chrome, and the callers (the facets route, the newest-decisions
 * shelf) render without them.
 *
 * "Any failure" includes a rejection, not only a returned error: the read
 * opens a database transaction to resolve the serving generation, and that
 * throws rather than answering. A caller awaiting this beside something it
 * does need — the shelf reads its courts in the same `Promise.all` — would
 * otherwise lose the whole page to a facet read, which is the one thing this
 * function exists to prevent.
 */
export const readBrowseFacets = async (
  country: string,
): Promise<LegalBrowseFacets> => {
  const result = await Result.tryPromise({
    try: async () => await readBrowseFacetsResult(country),
    catch: (cause) =>
      new LegalBrowseFacetsError({ message: "read failed", cause }),
  });
  const facets = Result.isError(result) ? result : result.value;
  if (Result.isError(facets)) {
    // An empty set collapses the selects into free-text filters, which is a
    // degraded page, not a broken one.
    logger.warn("case_law.browse_facets.unavailable", {
      "error.type": errorTag(facets.error),
    });
    return EMPTY_FACETS;
  }

  return facets.value;
};
