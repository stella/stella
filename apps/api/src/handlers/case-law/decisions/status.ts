import { Result, TaggedError } from "better-result";
import { inArray, notInArray, sql } from "drizzle-orm";

import { caseLawDecisions } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import type {
  CaseLawPublicReadDb,
  CaseLawPublicReadTransaction,
} from "@/api/lib/case-law-public-read-db";
import { readNonRedistributableCaseLawSourceIds } from "@/api/lib/case-law/non-redistributable-sources";
import { errorTag } from "@/api/lib/errors/utils";
import { logger } from "@/api/lib/observability/logger";
import {
  definePublicLawSharedQuery,
  PUBLIC_LAW_SHARED_QUERY,
} from "@/api/lib/public-law-shared-query";

/** How much public case law the database holds and when it last changed. */
export type CaseLawCorpusStatus = {
  /** The planner's row estimate less the withheld sources' rows: a magnitude, not a ledger. */
  decisions: number;
  /** ISO 8601, or null while the public table is empty. */
  updatedAt: string | null;
};

class CorpusStatusError extends TaggedError("CorpusStatusError")<{
  message: string;
  cause?: unknown;
}> {}

type CorpusStatusLoad = {
  /** The sources a public surface may not count, as the other public reads exclude them. */
  excludedSourceIds: readonly SafeId<"caseLawSource">[];
};

/**
 * One indexed aggregate and one catalogue read: `max(updated_at)` walks the
 * end of its index, and `reltuples` is what the planner already knows. A
 * withheld source's rows come off through the same predicate every public
 * read applies, so the status describes the corpus a reader can reach. An
 * exact `count(*)` would read every row for a number nobody compares.
 */
export const readCaseLawCorpusStatusQuery = definePublicLawSharedQuery(
  PUBLIC_LAW_SHARED_QUERY.caseLawCorpusStatus,
  async (
    tx: CaseLawPublicReadTransaction,
    { excludedSourceIds }: CorpusStatusLoad,
  ): Promise<CaseLawCorpusStatus> => {
    const withheldRows =
      excludedSourceIds.length === 0
        ? sql`0`
        : sql`(SELECT count(*) FROM ${caseLawDecisions} WHERE ${inArray(caseLawDecisions.sourceId, [...excludedSourceIds])})`;
    const [row] = await tx
      .select({
        decisions: sql<number>`greatest(greatest((SELECT reltuples FROM pg_class WHERE oid = 'case_law_decisions'::regclass), 0)::bigint - ${withheldRows}, 0)::int`,
        updatedAt: sql<
          string | null
        >`to_json(max(${caseLawDecisions.updatedAt})) #>> '{}'`,
      })
      .from(caseLawDecisions)
      .where(
        excludedSourceIds.length === 0
          ? undefined
          : notInArray(caseLawDecisions.sourceId, [...excludedSourceIds]),
      );

    return {
      decisions: row?.decisions ?? 0,
      updatedAt: row?.updatedAt ?? null,
    };
  },
);

const STATUS_CACHE_TTL_MS = 5 * 60 * 1000;

let cached: {
  key: string;
  readAt: number;
  value: CaseLawCorpusStatus;
} | null = null;

const EMPTY_STATUS: CaseLawCorpusStatus = { decisions: 0, updatedAt: null };

export const readCaseLawCorpusStatusHandler = async (
  caseLawDb: CaseLawPublicReadDb,
): Promise<CaseLawCorpusStatus> => {
  // Read ahead of the cache: source policy is an input to the answer, so a
  // revocation changes the key rather than waiting out the window.
  const excludedSourceIds = await readNonRedistributableCaseLawSourceIds();
  if (Result.isError(excludedSourceIds)) {
    logger.warn("case_law.corpus_status.unavailable", {
      "error.type": errorTag(excludedSourceIds.error),
    });
    return EMPTY_STATUS;
  }
  const key = excludedSourceIds.value.toSorted().join(",");
  const now = Date.now();
  if (cached?.key === key && now - cached.readAt < STATUS_CACHE_TTL_MS) {
    return cached.value;
  }

  const result = await Result.tryPromise({
    try: async () =>
      await caseLawDb(
        async (tx) =>
          await readCaseLawCorpusStatusQuery(tx, {
            excludedSourceIds: excludedSourceIds.value,
          }),
      ),
    catch: (cause) =>
      new CorpusStatusError({
        message:
          cause instanceof Error
            ? cause.message
            : "reading the case-law corpus status failed",
        cause,
      }),
  });
  if (Result.isError(result)) {
    // The status is a hint beside the box, not the page: degrade to "unknown".
    logger.warn("case_law.corpus_status.unavailable", {
      "error.type": errorTag(result.error),
    });
    return EMPTY_STATUS;
  }

  cached = { key, readAt: now, value: result.value };
  return result.value;
};
