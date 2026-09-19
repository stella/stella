import { Result, TaggedError } from "better-result";

import {
  type CaseLawJurisdiction,
  isCaseLawJurisdiction,
} from "@stll/api-contract/case-law-jurisdictions";
import { PUBLIC_CASE_LAW_COUNTRIES } from "@stll/api-contract/case-law-launch-readiness";

import { caseLawSources, SOURCE_TOTAL_ORIGIN } from "@/api/db/schema";
import type { SourceTotalOrigin } from "@/api/db/schema";
import {
  CASE_LAW_TOTAL_REPORTER,
  type CaseLawCountryCompleteness,
  type CaseLawCoverageHealth,
  type CaseLawSourceCompleteness,
  type CaseLawStoredCount,
  type CaseLawTotalReporter,
  caseLawCountryCompleteness,
  caseLawCountryHealth,
  caseLawSourceCompleteness,
  caseLawSourceHealth,
} from "@/api/handlers/case-law/decisions/coverage-health";
import {
  type CaseLawSourceCounts,
  readCaseLawSourceCountsQuery,
} from "@/api/handlers/case-law/decisions/coverage-stored-counts";
import { readBrowseFacetsUnderPolicy } from "@/api/handlers/case-law/decisions/facets";
import {
  type CaseLawCourtStatusRow,
  caseLawCourtStatusRows,
  readCaseLawCourtActivityQuery,
} from "@/api/handlers/case-law/decisions/status-courts";
import type { SafeId } from "@/api/lib/branded-types";
import type {
  CaseLawPublicReadDb,
  CaseLawPublicReadTransaction,
} from "@/api/lib/case-law-public-read-db";
import { loadCourtWeights } from "@/api/lib/case-law/court-weights";
import { readNonRedistributableCaseLawSourceIds } from "@/api/lib/case-law/non-redistributable-sources";
import { redistributableCaseLawSource } from "@/api/lib/case-law/redistribution";
import { errorTag } from "@/api/lib/errors/utils";
import { ADAPTER_MANIFESTS } from "@/api/lib/legal-search/adapter-manifest";
import { createTtlResultCache } from "@/api/lib/legal-search/browse-facets-cache";
import { CASE_LAW_SOURCE_ROWS_BOUND } from "@/api/lib/legal-search/ingestion-constants";
import { createUnrecognizedSourceReporter } from "@/api/lib/legal-search/source-registry-membership";
import type { LegalBrowseFacets } from "@/api/lib/legal-search/types";
import { LIMITS } from "@/api/lib/limits";
import { logger } from "@/api/lib/observability/logger";
import {
  definePublicLawSharedQuery,
  PUBLIC_LAW_SHARED_QUERY,
} from "@/api/lib/public-law-shared-query";

/**
 * How much case law the corpus holds, per country and per source, and whether
 * each is being kept up.
 *
 * Deliberately not country-scoped: the page's job is the whole picture in one
 * round trip, and a country a reader has to already know the code of is not a
 * picture. That also puts this read outside the per-country admission boundary
 * the other public case-law reads carry, so admission appears here as a
 * property of each country rather than as a 404 — a country the public search
 * does not answer for is reported `in-preparation`, with stored numbers,
 * rather than hidden.
 *
 * Two populations of number appear, and they are never added together:
 *
 * - `searchable`, from the serving index, is what a public search can find.
 *   Only an admitted country has one.
 * - `stored`, counted from the corpus itself, is what is held, including the
 *   identities a publisher listed whose document has not arrived. It is what
 *   the publisher's own total describes, so it is the completeness numerator.
 */

/** Whether a country's decisions can be searched publicly yet. */
export const CASE_LAW_COVERAGE_AVAILABILITY = {
  /** Admitted: the numbers come from the index a public search reads. */
  SEARCHABLE: "searchable",
  /** Ingested, not yet admitted: the numbers are what the corpus stores. */
  IN_PREPARATION: "in-preparation",
} as const;

export type CaseLawCoverageAvailability =
  (typeof CASE_LAW_COVERAGE_AVAILABILITY)[keyof typeof CASE_LAW_COVERAGE_AVAILABILITY];

/** One court feed, as a public page may describe it. */
export type CaseLawCoverageSource = {
  /**
   * The adapter's key, which is also its name in the open-source registry.
   * It identifies the feed without exposing the source row's own id.
   */
  adapterKey: string;
  /** The publisher's name for the corpus. */
  name: string;
  /** Where the publisher offers it, for attribution. */
  publicHomeUrl: string;
  health: CaseLawCoverageHealth;
  /** ISO 8601; null before the first run. */
  lastSyncAt: string | null;
  completeness: CaseLawSourceCompleteness;
  /** Decisions published for this source in the last seven days. */
  addedLastWeek: number;
};

type CaseLawCoverageCountryBase = {
  /** ISO 3166-1 alpha-3, or `EU` for the Court of Justice. */
  country: CaseLawJurisdiction;
  health: CaseLawCoverageHealth;
  /** Everything the corpus holds for the country, listing-only rows included. */
  stored: CaseLawStoredCount;
  addedLastWeek: number;
  completeness: CaseLawCountryCompleteness;
  sources: readonly CaseLawCoverageSource[];
};

export type CaseLawCoverageCountry =
  | (CaseLawCoverageCountryBase & {
      availability: typeof CASE_LAW_COVERAGE_AVAILABILITY.SEARCHABLE;
      /** What a public search can find: the serving index's country bucket. */
      searchable: number;
      /** Earliest and latest decision year the index holds; null when empty. */
      decisionYearFrom: number | null;
      decisionYearTo: number | null;
      /** The country's courts, apex tiers named and the rest grouped. */
      courts: readonly CaseLawCourtStatusRow[];
    })
  | (CaseLawCoverageCountryBase & {
      availability: typeof CASE_LAW_COVERAGE_AVAILABILITY.IN_PREPARATION;
    });

export type CaseLawCoverage = {
  /** ISO 8601 instant the figures were computed. */
  generatedAt: string;
  /**
   * The two populations, kept apart. Summing them would count a searchable
   * decision twice and imply that an in-preparation country can be searched.
   */
  totals: {
    searchable: number;
    stored: CaseLawStoredCount;
  };
  countries: readonly CaseLawCoverageCountry[];
};

class CoverageError extends TaggedError("CoverageError")<{
  message: string;
  cause?: unknown;
}> {}

/**
 * Who a persisted total came from. Total over the stored origins, so a new
 * origin has to be given a public reading here before it compiles; the page
 * names the reporter because "the publisher says so" and "we counted it by
 * hand" are different warranties on the same number.
 *
 * The origin as stored is a plain column, so the lookup goes through a map
 * keyed by string: a value outside the set is reported as no reporter, which
 * makes the trio read as never measured rather than as a guess.
 */
const REPORTER_BY_TOTAL_ORIGIN = {
  [SOURCE_TOTAL_ORIGIN.ADAPTER_POLL]: CASE_LAW_TOTAL_REPORTER.PUBLISHER,
  [SOURCE_TOTAL_ORIGIN.OPERATOR]: CASE_LAW_TOTAL_REPORTER.OPERATOR,
} as const satisfies Record<SourceTotalOrigin, CaseLawTotalReporter>;

const REPORTER_BY_ORIGIN_VALUE: ReadonlyMap<string, CaseLawTotalReporter> =
  new Map(Object.entries(REPORTER_BY_TOTAL_ORIGIN));

const reporterOf = (origin: string | null): CaseLawTotalReporter | null =>
  origin === null ? null : (REPORTER_BY_ORIGIN_VALUE.get(origin) ?? null);

/**
 * The adapter registry keyed the way a source row names it. A row whose key
 * has no manifest is history the registry no longer knows about, which the
 * loader reports rather than placing in a country it guessed.
 */
const MANIFEST_BY_ADAPTER_KEY = new Map(
  Object.values(ADAPTER_MANIFESTS).map((manifest) => [manifest.key, manifest]),
);

export type CaseLawCoverageSourceRow = {
  id: SafeId<"caseLawSource">;
  adapterKey: string;
  enabled: boolean;
  lastSyncAt: Date | null;
  reportedTotal: number | null;
  reportedTotalAsOf: Date | null;
  reportedTotalOrigin: string | null;
};

/**
 * Every redistributable court feed, with the freshness and completeness
 * bookkeeping a public page may state.
 *
 * The cursor, the lease, the observation orders and the source's own
 * configuration are not selected: they are the ingestion service's state, and
 * nothing a reader of the corpus needs. The redistribution gate is applied
 * here rather than per number, so a withheld source contributes to nothing.
 */
export const readCaseLawCoverageSourcesQuery = definePublicLawSharedQuery(
  PUBLIC_LAW_SHARED_QUERY.caseLawCoverageSources,
  async (
    tx: CaseLawPublicReadTransaction,
  ): Promise<CaseLawCoverageSourceRow[]> =>
    await tx
      .select({
        id: caseLawSources.id,
        adapterKey: caseLawSources.adapterKey,
        enabled: caseLawSources.enabled,
        lastSyncAt: caseLawSources.lastSyncAt,
        reportedTotal: caseLawSources.reportedTotal,
        reportedTotalAsOf: caseLawSources.reportedTotalAsOf,
        reportedTotalOrigin: caseLawSources.reportedTotalOrigin,
      })
      .from(caseLawSources)
      .where(redistributableCaseLawSource)
      .orderBy(caseLawSources.adapterKey)
      .limit(CASE_LAW_SOURCE_ROWS_BOUND),
);

/** The earliest and latest year the index reports for a jurisdiction. */
const decisionYearBounds = (
  facets: LegalBrowseFacets,
): { from: number | null; to: number | null } => {
  let from: number | null = null;
  let to: number | null = null;
  for (const { value } of facets.year) {
    const year = Number(value);
    if (!Number.isInteger(year)) {
      continue;
    }
    from = from === null || year < from ? year : from;
    to = to === null || year > to ? year : to;
  }
  return { from, to };
};

const NO_COUNTS: CaseLawSourceCounts = {
  stored: 0,
  capped: false,
  addedLastWeek: 0,
};

type CoverageLoad = {
  excludedSourceIds: readonly SafeId<"caseLawSource">[];
  now: Date;
  readSources: () => Promise<CaseLawCoverageSourceRow[]>;
  readCounts: (
    sourceIds: readonly SafeId<"caseLawSource">[],
  ) => Promise<ReadonlyMap<string, CaseLawSourceCounts> | null>;
  readFacets: (
    country: string,
  ) => Promise<Result<LegalBrowseFacets, { message: string }>>;
  readCourts: (options: {
    country: string;
    buckets: LegalBrowseFacets["court"];
  }) => Promise<readonly CaseLawCourtStatusRow[]>;
};

const coverageError = (fallback: string) => (cause: unknown) =>
  new CoverageError({
    message: cause instanceof Error ? cause.message : fallback,
    cause,
  });

/**
 * The whole page, assembled from the source catalogue outward.
 *
 * Countries come from the sources that feed them, through the adapter
 * manifest, rather than from a scan of the corpus for country codes: a
 * country nothing ingests into is not a country this page can say anything
 * useful about, and a source whose adapter has been retired is reported
 * rather than silently dropped.
 */
export const loadCaseLawCoverage = async ({
  excludedSourceIds,
  now,
  readCounts,
  readCourts,
  readFacets,
  readSources,
}: CoverageLoad): Promise<Result<CaseLawCoverage, CoverageError>> => {
  const sources = await Result.tryPromise({
    try: readSources,
    catch: coverageError("reading the case-law source catalogue failed"),
  });
  if (Result.isError(sources)) {
    return sources;
  }

  const withheld = new Set<string>(excludedSourceIds.map(String));
  const admitted = sources.value.filter(({ id }) => !withheld.has(String(id)));
  const counts = await readCounts(admitted.map(({ id }) => id));

  const reportUnrecognizedSource =
    createUnrecognizedSourceReporter("case_law.coverage");
  const byCountry = new Map<
    CaseLawJurisdiction,
    { sources: CaseLawCoverageSource[]; stored: number; capped: boolean }
  >();

  for (const source of admitted) {
    const manifest = MANIFEST_BY_ADAPTER_KEY.get(source.adapterKey);
    if (manifest === undefined || !isCaseLawJurisdiction(manifest.country)) {
      // A row whose adapter is not registered cannot be placed in a country,
      // so it is left out of the page and reported instead of counted
      // silently into whichever country happened to be first.
      reportUnrecognizedSource(source.adapterKey);
      continue;
    }
    const sourceCounts = counts?.get(String(source.id)) ?? NO_COUNTS;
    const stored: CaseLawStoredCount | null =
      counts === null
        ? null
        : {
            precision: sourceCounts.capped ? "at-least" : "exact",
            decisions: sourceCounts.stored,
          };
    const entry = byCountry.get(manifest.country) ?? {
      sources: [],
      stored: 0,
      capped: false,
    };
    entry.sources.push({
      adapterKey: source.adapterKey,
      name: manifest.name,
      publicHomeUrl: manifest.publicHomeUrl,
      health: caseLawSourceHealth({
        enabled: source.enabled,
        lastSyncAt: source.lastSyncAt,
        now,
      }),
      lastSyncAt: source.lastSyncAt?.toISOString() ?? null,
      completeness: caseLawSourceCompleteness({
        reportedTotal: source.reportedTotal,
        reportedTotalAsOf: source.reportedTotalAsOf,
        reportedBy: reporterOf(source.reportedTotalOrigin),
        stored,
        now,
      }),
      addedLastWeek: sourceCounts.addedLastWeek,
    });
    entry.stored += sourceCounts.stored;
    entry.capped = entry.capped || sourceCounts.capped;
    byCountry.set(manifest.country, entry);
  }

  const countries: CaseLawCoverageCountry[] = [];
  let searchableTotal = 0;
  let storedTotal = 0;
  let storedCapped = false;

  // Sorted so the page's order is the payload's order and two requests a
  // minute apart cannot reshuffle the table. Codepoint order rather than the
  // reader's collation: these are ISO codes, not words, and the page orders
  // the rows it renders by what its own locale says about their names.
  for (const [country, entry] of [...byCountry].toSorted(([left], [right]) =>
    left < right ? -1 : Number(left > right),
  )) {
    const base = {
      country,
      health: caseLawCountryHealth(entry.sources.map(({ health }) => health)),
      stored: {
        precision: entry.capped ? "at-least" : "exact",
        decisions: entry.stored,
      },
      addedLastWeek: entry.sources.reduce(
        (total, { addedLastWeek }) => total + addedLastWeek,
        0,
      ),
      completeness: caseLawCountryCompleteness(
        entry.sources.map(({ completeness }) => completeness),
      ),
      sources: entry.sources,
    } satisfies CaseLawCoverageCountryBase;
    storedTotal += entry.stored;
    storedCapped = storedCapped || entry.capped;

    const isAdmitted = PUBLIC_CASE_LAW_COUNTRIES.some(
      (candidate) => candidate === country,
    );
    if (!isAdmitted) {
      countries.push({
        ...base,
        availability: CASE_LAW_COVERAGE_AVAILABILITY.IN_PREPARATION,
      });
      continue;
    }

    const facets = await readFacets(country);
    if (Result.isError(facets)) {
      // An admitted country whose index cannot be read has no searchable
      // number, and zero is not that: the row degrades to what is stored,
      // which is true whatever the index is doing.
      logger.warn("case_law.coverage.facets_unavailable", { country });
      countries.push({
        ...base,
        availability: CASE_LAW_COVERAGE_AVAILABILITY.IN_PREPARATION,
      });
      continue;
    }
    const bucket = facets.value.country.find(({ value }) => value === country);
    const searchable = bucket?.count ?? 0;
    searchableTotal += searchable;
    const { from, to } = decisionYearBounds(facets.value);
    const courts = await Result.tryPromise({
      try: async () =>
        await readCourts({
          country,
          buckets: facets.value.court.slice(0, LIMITS.caseLawFacetLimit),
        }),
      catch: coverageError("reading the per-court breakdown failed"),
    });
    if (Result.isError(courts)) {
      logger.warn("case_law.coverage.courts_unavailable", {
        country,
        "error.type": errorTag(courts.error),
      });
    }
    countries.push({
      ...base,
      availability: CASE_LAW_COVERAGE_AVAILABILITY.SEARCHABLE,
      searchable,
      decisionYearFrom: from,
      decisionYearTo: to,
      courts: Result.isError(courts) ? [] : courts.value,
    });
  }

  return Result.ok({
    generatedAt: now.toISOString(),
    totals: {
      searchable: searchableTotal,
      stored: {
        precision: storedCapped ? "at-least" : "exact",
        decisions: storedTotal,
      },
    },
    countries,
  });
};

const COVERAGE_CACHE_TTL_MS = 15 * 60 * 1000;
/**
 * A failure is held briefly rather than retried by the next request: the
 * per-source counts run on a two-connection pool, and a read that fails slowly
 * must not be re-entered request after request.
 */
const COVERAGE_CACHE_FAILURE_TTL_MS = 60 * 1000;
const COVERAGE_CACHE_MAX_ENTRIES = 4;

/**
 * How long a client and a shared cache may hold the page.
 *
 * Matched to the server's own window: the figures change when ingestion runs,
 * which is on the order of hours, and a page whose numbers are fifteen minutes
 * old is not misleading about a corpus measured in millions.
 */
export const COVERAGE_CACHE_CONTROL =
  "public, max-age=900, stale-while-revalidate=3600";

const coverage = createTtlResultCache({
  load: loadCaseLawCoverage,
  // The source policy is an input to the answer, so a revocation changes the
  // key rather than waiting out the window; sorted because the set has no
  // order. `now` is deliberately not in the key: it is what the window is for.
  key: ({ excludedSourceIds }: CoverageLoad) =>
    excludedSourceIds.toSorted().join(","),
  ttlMs: COVERAGE_CACHE_TTL_MS,
  failureTtlMs: COVERAGE_CACHE_FAILURE_TTL_MS,
  maxEntries: COVERAGE_CACHE_MAX_ENTRIES,
});

export const readCaseLawCoverageHandler = async (
  caseLawDb: CaseLawPublicReadDb,
): Promise<CaseLawCoverage | { message: string }> => {
  // Read ahead of the cache: the source policy is an input to the answer, so a
  // revocation changes the key instead of keeping a withheld source's numbers
  // public for a whole window.
  const excludedSourceIds = await readNonRedistributableCaseLawSourceIds();
  if (Result.isError(excludedSourceIds)) {
    logger.warn("case_law.coverage.unavailable", {
      "error.type": errorTag(excludedSourceIds.error),
    });
    return { message: "Coverage is unavailable" };
  }

  const result = await coverage({
    excludedSourceIds: excludedSourceIds.value,
    now: new Date(),
    readSources: async () => await caseLawDb(readCaseLawCoverageSourcesQuery),
    readCounts: async (sourceIds) => {
      // The counts are the page's most expensive read and the one with a hard
      // bound. A source whose count did not finish is reported as uncounted
      // rather than as zero, so the statement's failure degrades the
      // completeness column and nothing else.
      const counts = await Result.tryPromise({
        try: async () =>
          await caseLawDb(
            async (tx) =>
              await readCaseLawSourceCountsQuery(tx, {
                sourceIds,
                now: new Date(),
              }),
          ),
        catch: coverageError("counting stored decisions failed"),
      });
      if (Result.isError(counts)) {
        logger.warn("case_law.coverage.counts_unavailable", {
          "error.type": errorTag(counts.error),
        });
        return null;
      }
      return counts.value;
    },
    readFacets: async (country) =>
      await readBrowseFacetsUnderPolicy({
        country,
        excludedSourceIds: excludedSourceIds.value,
      }),
    readCourts: async ({ buckets, country }) => {
      const [courtWeights, activity] = await Promise.all([
        loadCourtWeights(),
        caseLawDb(
          async (tx) =>
            await readCaseLawCourtActivityQuery(tx, {
              country,
              courts: buckets.map(({ value }) => value),
              excludedSourceIds: excludedSourceIds.value,
              now: new Date(),
            }),
        ),
      ]);
      return caseLawCourtStatusRows({
        activity,
        buckets,
        country,
        courtWeights,
      });
    },
  });
  if (Result.isError(result)) {
    // Unlike the hint beside the search box, this page IS the numbers:
    // degrading to zeros would publish a false corpus. It reports that it
    // cannot answer instead.
    logger.warn("case_law.coverage.unavailable", {
      "error.type": errorTag(result.error),
    });
    return { message: "Coverage is unavailable" };
  }

  return result.value;
};
