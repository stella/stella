import { Result } from "better-result";
import { status, t } from "elysia";
import type { Static } from "elysia";

import { readNonRedistributableCaseLawSourceIds } from "@/api/lib/case-law/non-redistributable-sources";
import { errorTag } from "@/api/lib/errors/utils";
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
  country: t.Optional(t.String({ maxLength: 3 })),
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
  if (country !== undefined && !isCorpusIndexJurisdiction(country)) {
    return status(400, { message: "Invalid country" });
  }

  return await readBrowseFacets(country);
};

/**
 * Cached facets for a validated jurisdiction (or the whole corpus). Degrades
 * to an empty set on any failure: facets are navigation chrome, and the
 * callers (the facets route, the newest-decisions shelf) render without them.
 */
export const readBrowseFacets = async (
  country: string | undefined,
): Promise<LegalBrowseFacets> => {
  // Read ahead of the cache, not inside it: source policy is an input to the
  // answer, so a revocation has to change the cache key. Reading it behind the
  // cache would keep a revoked source's buckets public for a whole window.
  // Failing closed here is deliberate — no facets beats stale ones.
  const excludedSourceIds = await readNonRedistributableCaseLawSourceIds();
  if (Result.isError(excludedSourceIds)) {
    logger.warn("case_law.browse_facets.unavailable", {
      "error.type": errorTag(excludedSourceIds.error),
    });
    return EMPTY_FACETS;
  }

  // The accepted code is case-insensitive, but the providers are not equally
  // so: the corpus index lowercases it into an index name while the Postgres
  // path compares it to the stored column, which is upper-case. Canonicalising
  // once here is what keeps the two answering the same question — and keeps
  // one jurisdiction to one cache entry.
  const result = await browseFacets({
    ...(country === undefined ? {} : { jurisdiction: country.toUpperCase() }),
    excludedSourceIds: excludedSourceIds.value,
    limit: LIMITS.caseLawFacetLimit,
  });
  if (Result.isError(result)) {
    // Facets are navigation chrome: an empty set collapses the selects into
    // free-text filters, which is a degraded page, not a broken one.
    logger.warn("case_law.browse_facets.unavailable", {
      "error.type": errorTag(result.error),
    });
    return EMPTY_FACETS;
  }

  return result.value;
};
