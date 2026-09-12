import { Result, TaggedError } from "better-result";
import { and, desc, eq, notInArray, sql } from "drizzle-orm";
import { status, t } from "elysia";
import type { Static } from "elysia";

import {
  publicCaseLawCountry,
  type PublicCaseLawCountry,
} from "@stll/api-contract/case-law-launch-readiness";

import { caseLawDecisions } from "@/api/db/schema";
import { readBrowseFacetsResult } from "@/api/handlers/case-law/decisions/facets";
import type { SafeId } from "@/api/lib/branded-types";
import type {
  CaseLawPublicReadDb,
  CaseLawPublicReadTransaction,
} from "@/api/lib/case-law-public-read-db";
import { readNonRedistributableCaseLawSourceIds } from "@/api/lib/case-law/non-redistributable-sources";
import { errorTag } from "@/api/lib/errors/utils";
import { createTtlResultCache } from "@/api/lib/legal-search/browse-facets-cache";
import type { LegalBrowseFacets } from "@/api/lib/legal-search/types";
import { logger } from "@/api/lib/observability/logger";
import {
  definePublicLawSharedQuery,
  PUBLIC_LAW_SHARED_QUERY,
} from "@/api/lib/public-law-shared-query";

/** How much public case law the corpus serves and when it last changed. */
export type CaseLawCorpusStatus = {
  /**
   * Decisions of the requested country the corpus index serves, so the number
   * beside the search box is the number a search can find. It is read from the
   * browse facets, and is the count their country bucket shows.
   */
  decisions: number;
  /** ISO 8601, or null while the public table is empty. */
  updatedAt: string | null;
};

class CorpusStatusError extends TaggedError("CorpusStatusError")<{
  message: string;
  cause?: unknown;
}> {}

type CorpusUpdatedAtRead = {
  country: PublicCaseLawCountry;
  /** The sources a public surface may not count, as the other public reads exclude them. */
  excludedSourceIds: readonly SafeId<"caseLawSource">[];
};

export const readCaseLawCorpusStatusQuerySchema = t.Object({
  country: t.String({ minLength: 2, maxLength: 3 }),
});

type ReadCaseLawCorpusStatusQuery = Static<
  typeof readCaseLawCorpusStatusQuerySchema
>;

/**
 * The newest public decision's timestamp: `case_law_decisions_updated_id_idx`
 * walked newest first and stopped at the first row the country and the source
 * policy admit. `max(updated_at)` cannot express that — an aggregate under a
 * country predicate has to read every row the predicate matches, which on a
 * corpus this size is a heap scan of a million rows per request.
 */
export const readCaseLawCorpusStatusQuery = definePublicLawSharedQuery(
  PUBLIC_LAW_SHARED_QUERY.caseLawCorpusStatus,
  async (
    tx: CaseLawPublicReadTransaction,
    { country, excludedSourceIds }: CorpusUpdatedAtRead,
  ): Promise<string | null> => {
    const [row] = await tx
      .select({
        updatedAt: sql<
          string | null
        >`to_json(${caseLawDecisions.updatedAt}) #>> '{}'`,
      })
      .from(caseLawDecisions)
      .where(
        and(
          eq(caseLawDecisions.country, country),
          excludedSourceIds.length === 0
            ? undefined
            : notInArray(caseLawDecisions.sourceId, [...excludedSourceIds]),
        ),
      )
      // The index's own order, so the walk stops at the first admitted row.
      .orderBy(desc(caseLawDecisions.updatedAt), desc(caseLawDecisions.id))
      .limit(1);

    return row?.updatedAt ?? null;
  },
);

type CorpusStatusLoad = CorpusUpdatedAtRead & {
  /**
   * The facets with their failure kept: a facets read that degraded to an
   * empty set would count as a corpus of zero decisions beside a real
   * timestamp, which is a wrong number, not an unknown status.
   */
  readFacets: (
    country: string,
  ) => Promise<Result<LegalBrowseFacets, { message: string }>>;
  readUpdatedAt: (read: CorpusUpdatedAtRead) => Promise<string | null>;
};

/**
 * Both halves of the status, each from the read that already answers it
 * cheaply: the count from the facets this page asks for anyway, the timestamp
 * from one index row.
 */
export const loadCaseLawCorpusStatus = async ({
  country,
  excludedSourceIds,
  readFacets,
  readUpdatedAt,
}: CorpusStatusLoad): Promise<
  Result<CaseLawCorpusStatus, CorpusStatusError>
> => {
  const [facets, updatedAt] = await Promise.all([
    readFacets(country),
    Result.tryPromise({
      try: async () => await readUpdatedAt({ country, excludedSourceIds }),
      catch: (cause) =>
        new CorpusStatusError({
          message:
            cause instanceof Error
              ? cause.message
              : "reading the newest public decision failed",
          cause,
        }),
    }),
  ]);
  if (Result.isError(facets)) {
    return Result.err(
      new CorpusStatusError({
        message: facets.error.message,
        cause: facets.error,
      }),
    );
  }
  if (Result.isError(updatedAt)) {
    return updatedAt;
  }
  // A jurisdiction the corpus holds nothing for has no bucket at all: that is
  // the empty corpus, not a missed lookup.
  const bucket = facets.value.country.find(({ value }) => value === country);
  return Result.ok({
    decisions: bucket?.count ?? 0,
    updatedAt: updatedAt.value,
  });
};

const STATUS_CACHE_TTL_MS = 5 * 60 * 1000;
const STATUS_CACHE_MAX_ENTRIES = 16;
/**
 * A failure is held briefly instead of being retried by the next request: the
 * timestamp read shares a pool of two connections with the rest of the page,
 * so a read that fails slowly must not be re-entered request after request.
 */
const STATUS_CACHE_FAILURE_TTL_MS = 30 * 1000;

const corpusStatus = createTtlResultCache({
  load: loadCaseLawCorpusStatus,
  // Source policy is an input to the answer, so a revocation changes the key
  // instead of waiting out the window; sorted because the set has no order.
  key: ({ country, excludedSourceIds }: CorpusStatusLoad) =>
    `${country}:${excludedSourceIds.toSorted().join(",")}`,
  ttlMs: STATUS_CACHE_TTL_MS,
  failureTtlMs: STATUS_CACHE_FAILURE_TTL_MS,
  maxEntries: STATUS_CACHE_MAX_ENTRIES,
});

const EMPTY_STATUS: CaseLawCorpusStatus = { decisions: 0, updatedAt: null };

export const readCaseLawCorpusStatusHandler = async (
  { country }: ReadCaseLawCorpusStatusQuery,
  caseLawDb: CaseLawPublicReadDb,
) => {
  const publicCountry = publicCaseLawCountry(country);
  if (publicCountry === null) {
    return status(404, { message: "Not Found" });
  }
  // Read ahead of the cache: source policy is an input to the answer, so a
  // revocation changes the key rather than waiting out the window.
  const excludedSourceIds = await readNonRedistributableCaseLawSourceIds();
  if (Result.isError(excludedSourceIds)) {
    logger.warn("case_law.corpus_status.unavailable", {
      "error.type": errorTag(excludedSourceIds.error),
    });
    return EMPTY_STATUS;
  }

  const result = await corpusStatus({
    country: publicCountry,
    excludedSourceIds: excludedSourceIds.value,
    readFacets: readBrowseFacetsResult,
    readUpdatedAt: async (read) =>
      await caseLawDb(
        async (tx) => await readCaseLawCorpusStatusQuery(tx, read),
      ),
  });
  if (Result.isError(result)) {
    // The status is a hint beside the box, not the page: degrade to "unknown".
    logger.warn("case_law.corpus_status.unavailable", {
      "error.type": errorTag(result.error),
    });
    return EMPTY_STATUS;
  }

  return result.value;
};
