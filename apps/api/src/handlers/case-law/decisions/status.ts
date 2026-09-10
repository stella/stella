import { Result, TaggedError } from "better-result";
import { and, eq, notInArray, sql } from "drizzle-orm";
import { status, t } from "elysia";
import type { Static } from "elysia";

import {
  publicCaseLawCountry,
  type PublicCaseLawCountry,
} from "@stll/api-contract/case-law-launch-readiness";
import { Temporal } from "@stll/time";

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
  /** The number of public decisions in the requested country. */
  decisions: number;
  /** ISO 8601, or null while the public table is empty. */
  updatedAt: string | null;
};

class CorpusStatusError extends TaggedError("CorpusStatusError")<{
  message: string;
  cause?: unknown;
}> {}

type CorpusStatusLoad = {
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
 * One country-scoped aggregate. The country index bounds the scan, and the
 * short-lived cache keeps it off the request path after the first read.
 */
export const readCaseLawCorpusStatusQuery = definePublicLawSharedQuery(
  PUBLIC_LAW_SHARED_QUERY.caseLawCorpusStatus,
  async (
    tx: CaseLawPublicReadTransaction,
    { country, excludedSourceIds }: CorpusStatusLoad,
  ): Promise<CaseLawCorpusStatus> => {
    const [row] = await tx
      .select({
        decisions: sql<number>`count(*)::int`,
        updatedAt: sql<
          string | null
        >`to_json(max(${caseLawDecisions.updatedAt})) #>> '{}'`,
      })
      .from(caseLawDecisions)
      .where(
        and(
          eq(caseLawDecisions.country, country),
          excludedSourceIds.length === 0
            ? undefined
            : notInArray(caseLawDecisions.sourceId, [...excludedSourceIds]),
        ),
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
  const key = `${publicCountry}:${excludedSourceIds.value.toSorted().join(",")}`;
  const now = Temporal.Now.instant().epochMilliseconds;
  if (cached?.key === key && now - cached.readAt < STATUS_CACHE_TTL_MS) {
    return cached.value;
  }

  const result = await Result.tryPromise({
    try: async () =>
      await caseLawDb(
        async (tx) =>
          await readCaseLawCorpusStatusQuery(tx, {
            country: publicCountry,
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
