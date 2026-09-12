import { Result } from "better-result";
import { status, t } from "elysia";
import type { Static } from "elysia";

import { publicCaseLawCountry } from "@stll/api-contract/case-law-launch-readiness";

import {
  type NonRedistributableSourcesError,
  readNonRedistributableCaseLawSourceIds,
} from "@/api/lib/case-law/non-redistributable-sources";
import { errorTag } from "@/api/lib/errors/utils";
import type { LegalBrowseFacetsError } from "@/api/lib/legal-search/browse-facets";
import { createBrowseFacetsCache } from "@/api/lib/legal-search/browse-facets-cache";
import { isCorpusIndexJurisdiction } from "@/api/lib/legal-search/index-naming";
import { getLegalSearchProvider } from "@/api/lib/legal-search/provider";
import type { LegalBrowseFacets } from "@/api/lib/legal-search/types";
import { LIMITS } from "@/api/lib/limits";
import { logger } from "@/api/lib/observability/logger";

/**
 * Facet counts for the public browse page: which countries, courts and years
 * the corpus holds, and how many decisions each has. Provider-dispatched, so a
 * deployment with a corpus index answers from engine aggregations while one
 * without still answers from Postgres.
 */

export const listDecisionFacetsQuerySchema = t.Object({
  country: t.String({ minLength: 2, maxLength: 3 }),
});

type ListDecisionFacetsQuery = Static<typeof listDecisionFacetsQuerySchema>;

const FACETS_CACHE_TTL_MS = 5 * 60 * 1000;
const FACETS_CACHE_MAX_ENTRIES = 32;

const EMPTY_FACETS: LegalBrowseFacets = { country: [], court: [], year: [] };

const browseFacets = createBrowseFacetsCache({
  load: async (query) => await getLegalSearchProvider().browseFacets(query),
  ttlMs: FACETS_CACHE_TTL_MS,
  maxEntries: FACETS_CACHE_MAX_ENTRIES,
});

export const listDecisionFacetsHandler = async ({
  country,
}: ListDecisionFacetsQuery) => {
  const publicCountry = publicCaseLawCountry(country);
  if (publicCountry === null || !isCorpusIndexJurisdiction(publicCountry)) {
    return status(404, { message: "Not Found" });
  }

  return await readBrowseFacets(publicCountry);
};

type BrowseFacetsReadError =
  | LegalBrowseFacetsError
  | NonRedistributableSourcesError;

/**
 * Cached facets for a validated jurisdiction, with the failure kept as a
 * value for a caller whose answer depends on them (the corpus status counts
 * from the country bucket, and a missing bucket must not read as zero).
 */
export const readBrowseFacetsResult = async (
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

  // The accepted code is case-insensitive, but the providers are not equally
  // so: the corpus index lowercases it into an index name while the Postgres
  // path compares it to the stored column, which is upper-case. Canonicalising
  // once here is what keeps the two answering the same question — and keeps
  // one jurisdiction to one cache entry.
  return await browseFacets({
    jurisdiction: country.toUpperCase(),
    excludedSourceIds: excludedSourceIds.value,
    limit: LIMITS.caseLawFacetLimit,
  });
};

/**
 * The same facets, degraded to an empty set on any failure: facets are
 * navigation chrome, and the callers (the facets route, the newest-decisions
 * shelf) render without them.
 */
export const readBrowseFacets = async (
  country: string,
): Promise<LegalBrowseFacets> => {
  const result = await readBrowseFacetsResult(country);
  if (Result.isError(result)) {
    // An empty set collapses the selects into free-text filters, which is a
    // degraded page, not a broken one.
    logger.warn("case_law.browse_facets.unavailable", {
      "error.type": errorTag(result.error),
    });
    return EMPTY_FACETS;
  }

  return result.value;
};
