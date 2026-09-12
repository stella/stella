import { Result } from "better-result";
import { status, t } from "elysia";
import type { Static } from "elysia";

import { publicCaseLawCountry } from "@stll/api-contract/case-law-launch-readiness";

import {
  type NonRedistributableSourcesError,
  readNonRedistributableCaseLawSourceIds,
} from "@/api/lib/case-law/non-redistributable-sources";
import { errorTag } from "@/api/lib/errors/utils";
import { LegalBrowseFacetsError } from "@/api/lib/legal-search/browse-facets";
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
> =>
  // The accepted code is case-insensitive, but the providers are not equally
  // so: the corpus index lowercases it into an index name while the Postgres
  // path compares it to the stored column, which is upper-case. Canonicalising
  // once here is what keeps the two answering the same question — and keeps
  // one jurisdiction to one cache entry.
  await browseFacets({
    jurisdiction: country.toUpperCase(),
    excludedSourceIds,
    limit: LIMITS.caseLawFacetLimit,
  });

/** The same facets under the current source policy. */
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
