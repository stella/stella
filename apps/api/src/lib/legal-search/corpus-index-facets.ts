import { Result } from "better-result";

import { LegalBrowseFacetsError } from "@/api/lib/legal-search/browse-facets";
import { corpusGeneration } from "@/api/lib/legal-search/corpus-family";
import { corpusIndexClusterForGeneration } from "@/api/lib/legal-search/corpus-generation-contract";
import { getCorpusIndexClient } from "@/api/lib/legal-search/corpus-index-client";
import { quoteCorpusValue } from "@/api/lib/legal-search/corpus-query";
import { corpusIndexRoute } from "@/api/lib/legal-search/index-naming";
import type {
  LegalBrowseFacets,
  LegalBrowseFacetsQuery,
} from "@/api/lib/legal-search/types";
import type { FacetBucket } from "@/api/lib/search/types";
import { isRecord } from "@/api/lib/type-guards";

/**
 * Browse-page facet counts served by corpus index aggregations instead of a
 * `GROUP BY` over the whole decisions table. The counts describe the corpus,
 * not a result set, so there is no text query to honour and the engine reads
 * only fast fields.
 *
 * The index is passage-granular: every passage carries its decision's shared
 * fields, so an unrestricted terms aggregation counts passages, not decisions.
 * `seq:0` restricts it to each decision's opening passage — `chunkDocument`
 * numbers passages from zero and always emits at least one, so exactly one
 * document per decision matches — and every bucket then counts decisions.
 *
 * Projection is only the first half of the redistribution gate: it keeps
 * ineligible sources out of the index, but revoking a source's redistribution
 * merely queues its documents for removal, so the query carries the currently
 * ineligible source ids and they are excluded here. That is the same posture
 * the search path takes when it re-applies the predicate while rehydrating
 * index candidates. The caller resolves them per request, ahead of its cache,
 * so a revocation changes the key rather than waiting out a window.
 *
 * What the index does NOT hold is also visible in these counts: a decision
 * with no canonical payload is never projected, so it is browseable in the
 * list yet absent from a bucket. That is the same set search can find, which
 * is the set these filters exist to narrow.
 */

const OPENING_PASSAGE_QUERY = "seq:0";

type BrowseFacetsQueryOptions = {
  excludedSourceIds: readonly string[];
  /** Set when the selected index holds other jurisdictions too. */
  jurisdictionClause: string | undefined;
};

/**
 * Opening passages, minus every source that may no longer be redistributed,
 * within the scoped jurisdiction where its index is shared. An aggregation
 * that dropped the source clause would keep counting revoked decisions for a
 * reconciliation window plus a cache window, so the test asserts it on the
 * request the engine would receive.
 */
const browseFacetsQuery = ({
  excludedSourceIds,
  jurisdictionClause,
}: BrowseFacetsQueryOptions): string => {
  const clauses = [OPENING_PASSAGE_QUERY];
  if (jurisdictionClause !== undefined) {
    clauses.push(`jurisdiction:${quoteCorpusValue(jurisdictionClause)}`);
  }
  if (excludedSourceIds.length > 0) {
    const excluded = excludedSourceIds
      .map((id) => `source:${quoteCorpusValue(id)}`)
      .join(" OR ");
    clauses.push(`NOT (${excluded})`);
  }
  return clauses.join(" AND ");
};

/**
 * Per-split candidate depth behind each bucket. Terms aggregations merge
 * per-split top-k lists, so a depth at `size` alone makes counts approximate
 * across many splits; at this depth the engine reports a
 * `doc_count_error_upper_bound` of 0 for every browse facet at current corpus
 * size, i.e. the counts are exact.
 */
const FACET_SEGMENT_SIZE = 5000;

type BrowseFacetSpec = {
  /** Index field the terms aggregation runs over. */
  field: string;
  /** Bucket order; mirrors the ORDER BY the Postgres facets use. */
  order: { _count: "desc" } | { _key: "desc" };
};

/**
 * One aggregation per response facet, named after the facet so the request
 * and the parse cannot drift. `country` reads `jurisdiction` because that is
 * the index's name for the decision's country.
 */
const BROWSE_FACETS = {
  country: { field: "jurisdiction", order: { _count: "desc" } },
  court: { field: "court", order: { _count: "desc" } },
  year: { field: "year", order: { _key: "desc" } },
} as const satisfies Record<keyof LegalBrowseFacets, BrowseFacetSpec>;

export const browseFacetNames = Object.keys(BROWSE_FACETS);

const buildAggregations = (limit: number): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(BROWSE_FACETS).map(([name, { field, order }]) => [
      name,
      {
        terms: {
          field,
          size: limit,
          segment_size: FACET_SEGMENT_SIZE,
          order,
        },
      },
    ]),
  );

/**
 * Terms buckets, or null when the engine returned a shape this facet cannot
 * be read from, or counts it will not vouch for. Null is a hard failure,
 * never an empty facet: silently reporting "no courts" would look like a
 * corpus with no decisions.
 */
const parseTermsBuckets = (aggregation: unknown): FacetBucket[] | null => {
  if (!isRecord(aggregation) || !Array.isArray(aggregation["buckets"])) {
    return null;
  }

  // `FACET_SEGMENT_SIZE` is a claim about the corpus, not a property of the
  // engine, and corpus growth or a split-topology change can outgrow it. The
  // engine states when it has: anything but a reported zero means the counts
  // are approximate, and serving them would put wrong numbers next to every
  // court with nothing to notice.
  if (aggregation["doc_count_error_upper_bound"] !== 0) {
    return null;
  }

  const buckets: FacetBucket[] = [];
  for (const bucket of aggregation["buckets"]) {
    if (!isRecord(bucket)) {
      return null;
    }
    const count = bucket["doc_count"];
    const key = bucket["key"];
    if (typeof count !== "number" || !Number.isFinite(count)) {
      return null;
    }
    if (typeof key === "string") {
      buckets.push({ value: key, count });
      continue;
    }
    // `year` is a u64 fast field and comes back as a JSON float (2024.0);
    // a non-integer key cannot come from one, so it is a parse failure.
    if (typeof key !== "number" || !Number.isInteger(key)) {
      return null;
    }
    buckets.push({ value: String(key), count });
  }
  return buckets;
};

export const corpusIndexBrowseFacets = async (
  query: LegalBrowseFacetsQuery,
): Promise<Result<LegalBrowseFacets, LegalBrowseFacetsError>> => {
  const generation = corpusGeneration(query.documentFamily ?? "case_law");
  // Scoped query → that jurisdiction's index, plus a jurisdiction clause when
  // that index holds other jurisdictions; unscoped → the generation glob (one
  // multi-index aggregation across every index of the generation).
  const { indexId, jurisdictionClause } = corpusIndexRoute(
    generation,
    query.jurisdiction,
  );

  const aggregated = await getCorpusIndexClient(
    corpusIndexClusterForGeneration(
      query.documentFamily ?? "case_law",
      generation,
    ),
  ).aggregate({
    indexId,
    query: browseFacetsQuery({
      excludedSourceIds: query.excludedSourceIds,
      jurisdictionClause,
    }),
    aggs: buildAggregations(query.limit),
  });
  if (Result.isError(aggregated)) {
    return Result.err(
      new LegalBrowseFacetsError({
        message: aggregated.error.message,
        cause: aggregated.error,
      }),
    );
  }

  const country = parseTermsBuckets(aggregated.value["country"]);
  const court = parseTermsBuckets(aggregated.value["court"]);
  const year = parseTermsBuckets(aggregated.value["year"]);
  if (country === null || court === null || year === null) {
    return Result.err(
      new LegalBrowseFacetsError({
        message:
          "corpus index returned an unreadable or approximate facet aggregation",
      }),
    );
  }

  return Result.ok({ country, court, year });
};
