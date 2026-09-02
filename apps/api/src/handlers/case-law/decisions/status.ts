import { Result, TaggedError } from "better-result";
import { sql } from "drizzle-orm";

import { caseLawDecisions } from "@/api/db/schema";
import type {
  CaseLawPublicReadDb,
  CaseLawPublicReadTransaction,
} from "@/api/lib/case-law-public-read-db";
import { errorTag } from "@/api/lib/errors/utils";
import { logger } from "@/api/lib/observability/logger";
import {
  definePublicLawSharedQuery,
  PUBLIC_LAW_SHARED_QUERY,
} from "@/api/lib/public-law-shared-query";

/** How much case law the database holds and when it last changed. */
export type CaseLawCorpusStatus = {
  /** The planner's row estimate, refreshed by autovacuum; a magnitude, not a ledger. */
  decisions: number;
  /** ISO 8601, or null while the table is empty. */
  updatedAt: string | null;
};

class CorpusStatusError extends TaggedError("CorpusStatusError")<{
  message: string;
  cause?: unknown;
}> {}

/**
 * One indexed aggregate and one catalogue read: `max(updated_at)` walks the
 * end of its index, and `reltuples` is what the planner already knows.
 * An exact `count(*)` would read every row for a number nobody compares.
 */
export const readCaseLawCorpusStatusQuery = definePublicLawSharedQuery(
  PUBLIC_LAW_SHARED_QUERY.caseLawCorpusStatus,
  async (tx: CaseLawPublicReadTransaction): Promise<CaseLawCorpusStatus> => {
    const [row] = await tx
      .select({
        decisions: sql<number>`greatest((SELECT reltuples FROM pg_class WHERE oid = 'case_law_decisions'::regclass), 0)::bigint::int`,
        updatedAt: sql<
          string | null
        >`to_json(max(${caseLawDecisions.updatedAt})) #>> '{}'`,
      })
      .from(caseLawDecisions);

    return {
      decisions: row?.decisions ?? 0,
      updatedAt: row?.updatedAt ?? null,
    };
  },
);

const STATUS_CACHE_TTL_MS = 5 * 60 * 1000;

let cached: { readAt: number; value: CaseLawCorpusStatus } | null = null;

const EMPTY_STATUS: CaseLawCorpusStatus = { decisions: 0, updatedAt: null };

export const readCaseLawCorpusStatusHandler = async (
  caseLawDb: CaseLawPublicReadDb,
): Promise<CaseLawCorpusStatus> => {
  const now = Date.now();
  if (cached !== null && now - cached.readAt < STATUS_CACHE_TTL_MS) {
    return cached.value;
  }

  const result = await Result.tryPromise({
    try: async () => await caseLawDb(readCaseLawCorpusStatusQuery),
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

  cached = { readAt: now, value: result.value };
  return result.value;
};
