import { Result } from "better-result";
import { status, t } from "elysia";
import type { Static } from "elysia";

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

  const result = await browseFacets({
    ...(country === undefined ? {} : { jurisdiction: country }),
    limit: LIMITS.caseLawFacetLimit,
  });
  if (Result.isError(result)) {
    // Facets are navigation chrome: an empty set collapses the selects into
    // free-text filters, which is a degraded page, not a broken one.
    logger.warn("case_law.browse_facets.unavailable", {
      message: result.error.message,
    });
    return EMPTY_FACETS;
  }

  return result.value;
};
