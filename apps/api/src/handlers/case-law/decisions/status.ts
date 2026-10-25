import { Result, TaggedError } from "better-result";
import { and, desc, eq, notInArray, sql } from "drizzle-orm";
import * as v from "valibot";

import {
  PUBLIC_CASE_LAW_COUNTRIES,
  type PublicCaseLawCountry,
  publicCaseLawCountry,
} from "@stll/api-contract/case-law-launch-readiness";

import { caseLawSources, publishedCaseLawDecisions } from "@/api/db/schema";
import { caseLawSourceJurisdiction } from "@/api/handlers/case-law/decisions/coverage";
import {
  CASE_LAW_COVERAGE_HEALTH,
  caseLawCountryHealth,
  type CaseLawCoverageHealth,
  caseLawSourceHealth,
} from "@/api/handlers/case-law/decisions/coverage-health";
import { readBrowseFacetsUnderPolicy } from "@/api/handlers/case-law/decisions/facets";
import { status } from "@/api/http/status";
import type { SafeId } from "@/api/lib/branded-types";
import type {
  CaseLawPublicReadDb,
  CaseLawPublicReadTransaction,
} from "@/api/lib/case-law-public-read-db";
import { readNonRedistributableCaseLawSourceIds } from "@/api/lib/case-law/non-redistributable-sources";
import { redistributableCaseLawSource } from "@/api/lib/case-law/redistribution";
import { type BoundedReadResult, readBounded } from "@/api/lib/db/read-bounded";
import { errorTag } from "@/api/lib/errors/utils";
import { createTtlResultCache } from "@/api/lib/legal-search/browse-facets-cache";
import { CASE_LAW_SOURCE_ROWS_BOUND } from "@/api/lib/legal-search/ingestion-constants";
import {
  readPublicLawCountry,
  tPublicLawCountry,
} from "@/api/lib/legal-search/public-law-country";
import type { LegalBrowseFacets } from "@/api/lib/legal-search/types";
import { logger } from "@/api/lib/observability/logger";
import {
  definePublicLawSharedQuery,
  PUBLIC_LAW_SHARED_QUERY,
} from "@/api/lib/public-law-shared-query";

/**
 * How much public case law the corpus serves, when it last changed, and
 * whether its sources are being kept up. The coverage page states the same
 * country source by source and court by court; this is the line beside the
 * search box that points there.
 */
export type CaseLawCorpusStatus = {
  /**
   * Decisions of the requested country the corpus index serves, so the number
   * beside the search box is the number a search can find. It is read from the
   * browse facets, and is the count their country bucket shows.
   */
  decisions: number;
  /** ISO 8601, or null while the public table is empty. */
  updatedAt: string | null;
  /**
   * The country's health as the coverage page states it: the same sources,
   * the same windows and the same worst-of rule, so the badge and the page
   * cannot disagree about whether the country is current.
   */
  health: CaseLawCoverageHealth;
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

export const readCaseLawCorpusStatusQuerySchema = v.object({
  country: tPublicLawCountry,
});

type ReadCaseLawCorpusStatusQuery = v.InferOutput<
  typeof readCaseLawCorpusStatusQuerySchema
>;

/**
 * The newest public decision's timestamp:
 * `case_law_decisions_country_updated_idx` walked newest first within the
 * country and stopped at the first row the source policy admits. Led by
 * country so a large ingestion batch elsewhere is never walked past.
 * `max(updated_at)` cannot express that — an aggregate under a country
 * predicate has to read every row the predicate matches, which on a corpus
 * this size is a heap scan of a million rows per request.
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
        >`to_json(${publishedCaseLawDecisions.updatedAt}) #>> '{}'`,
      })
      .from(publishedCaseLawDecisions)
      .where(
        and(
          eq(publishedCaseLawDecisions.country, country),
          excludedSourceIds.length === 0
            ? undefined
            : notInArray(publishedCaseLawDecisions.sourceId, [
                ...excludedSourceIds,
              ]),
        ),
      )
      // The index's own order, so the walk stops at the first admitted row.
      .orderBy(
        desc(publishedCaseLawDecisions.updatedAt),
        desc(publishedCaseLawDecisions.id),
      )
      .limit(1);

    return row?.updatedAt ?? null;
  },
);

type CaseLawSourceHealthRow = {
  id: SafeId<"caseLawSource">;
  adapterKey: string;
  enabled: boolean;
  lastSyncAt: Date | null;
};

/**
 * The redistributable sources with only what their health is judged from.
 * The source table carries no country; the adapter's manifest places each
 * row, as it does for the coverage page. A registry past the bound is
 * reported as such: a truncated list could leave out the one stalled source.
 */
export const readCaseLawSourceHealthQuery = definePublicLawSharedQuery(
  PUBLIC_LAW_SHARED_QUERY.caseLawSourceHealth,
  async (
    tx: CaseLawPublicReadTransaction,
  ): Promise<BoundedReadResult<CaseLawSourceHealthRow>> =>
    await readBounded(
      tx
        .select({
          id: caseLawSources.id,
          adapterKey: caseLawSources.adapterKey,
          enabled: caseLawSources.enabled,
          lastSyncAt: caseLawSources.lastSyncAt,
        })
        .from(caseLawSources)
        .where(redistributableCaseLawSource)
        .orderBy(caseLawSources.adapterKey),
      CASE_LAW_SOURCE_ROWS_BOUND,
    ),
);

type CorpusStatusLoad = CorpusUpdatedAtRead & {
  /**
   * The facets with their failure kept: a facets read that degraded to an
   * empty set would count as a corpus of zero decisions beside a real
   * timestamp, which is a wrong number, not an unknown status. Both reads
   * take the same source-policy snapshot, so the count and the timestamp
   * describe one set of decisions.
   */
  readFacets: (
    read: CorpusUpdatedAtRead,
  ) => Promise<Result<LegalBrowseFacets, { message: string }>>;
  readUpdatedAt: (read: CorpusUpdatedAtRead) => Promise<string | null>;
  readSources: () => Promise<BoundedReadResult<CaseLawSourceHealthRow>>;
  /** The instant the health windows are measured back from. */
  now: Date;
};

const corpusStatusError = (fallback: string) => (cause: unknown) =>
  new CorpusStatusError({
    message: cause instanceof Error ? cause.message : fallback,
    cause,
  });

/**
 * Each part of the status from the read that already answers it cheaply: the
 * count from the facets this page asks for anyway, the timestamp from one
 * index row, the health from the small source table. Each read is normalised
 * to a value: the cache that holds the load would otherwise keep a rejected
 * promise for a full window. A failed source read fails the status rather
 * than reporting `unknown`, which the badge would state as a source that has
 * never run.
 */
export const loadCaseLawCorpusStatus = async ({
  country,
  excludedSourceIds,
  now,
  readFacets,
  readSources,
  readUpdatedAt,
}: CorpusStatusLoad): Promise<
  Result<CaseLawCorpusStatus, CorpusStatusError>
> => {
  const read = { country, excludedSourceIds };
  const [facets, updatedAt, sources] = await Promise.all([
    Result.tryPromise({
      try: async () => await readFacets(read),
      catch: corpusStatusError("reading the browse facets failed"),
    }),
    Result.tryPromise({
      try: async () => await readUpdatedAt(read),
      catch: corpusStatusError("reading the newest public decision failed"),
    }),
    Result.tryPromise({
      try: readSources,
      catch: corpusStatusError("reading the case-law sources failed"),
    }),
  ]);
  if (Result.isError(facets)) {
    return facets;
  }
  if (Result.isError(facets.value)) {
    return Result.err(
      new CorpusStatusError({
        message: facets.value.error.message,
        cause: facets.value.error,
      }),
    );
  }
  if (Result.isError(updatedAt)) {
    return updatedAt;
  }
  if (Result.isError(sources)) {
    return sources;
  }
  if (sources.value.type === "overflow") {
    return Result.err(
      new CorpusStatusError({
        message: `The case-law source registry exceeds the status read bound of ${sources.value.cap} rows.`,
      }),
    );
  }
  // A jurisdiction the corpus holds nothing for has no bucket at all: that is
  // the empty corpus, not a missed lookup.
  const bucket = facets.value.value.country.find(
    ({ value }) => value === country,
  );
  const withheld = new Set<string>(excludedSourceIds.map(String));
  const health = caseLawCountryHealth(
    sources.value.rows
      .filter(
        (source) =>
          !withheld.has(String(source.id)) &&
          caseLawSourceJurisdiction(source.adapterKey) === country,
      )
      .map(({ enabled, lastSyncAt }) =>
        caseLawSourceHealth({ enabled, lastSyncAt, now }),
      ),
  );
  return Result.ok({
    decisions: bucket?.count ?? 0,
    updatedAt: updatedAt.value,
    health,
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

const EMPTY_STATUS: CaseLawCorpusStatus = {
  decisions: 0,
  updatedAt: null,
  health: CASE_LAW_COVERAGE_HEALTH.UNKNOWN,
};

export const readCaseLawCorpusStatusHandler = async (
  { country }: ReadCaseLawCorpusStatusQuery,
  caseLawDb: CaseLawPublicReadDb,
) => {
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
    now: new Date(),
    readFacets: readBrowseFacetsUnderPolicy,
    readUpdatedAt: async (read) =>
      await caseLawDb(
        async (tx) => await readCaseLawCorpusStatusQuery(tx, read),
      ),
    readSources: async () => await caseLawDb(readCaseLawSourceHealthQuery),
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
