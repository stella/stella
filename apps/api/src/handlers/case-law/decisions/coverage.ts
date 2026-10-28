import { Result, TaggedError } from "better-result";
import { sql } from "drizzle-orm";
import * as v from "valibot";

import {
  type CaseLawJurisdiction,
  isCaseLawJurisdiction,
} from "@stll/api-contract/case-law-jurisdictions";
import { PUBLIC_CASE_LAW_COUNTRIES } from "@stll/api-contract/case-law-launch-readiness";

import {
  caseLawBrowseFacetCounts,
  caseLawSources,
  publishedCaseLawDecisions,
  SOURCE_TOTAL_ORIGIN,
} from "@/api/db/schema";
import type { SourceTotalOrigin } from "@/api/db/schema";
import { envBase } from "@/api/env-base";
import {
  type CaseLawSourceArrivals,
  readCaseLawArrivalsQuery,
} from "@/api/handlers/case-law/decisions/coverage-arrivals";
import {
  CASE_LAW_TOTAL_REPORTER,
  type CaseLawCountryCompleteness,
  caseLawCountryCompleteness,
  caseLawCountryHealth,
  type CaseLawCoverageHealth,
  type CaseLawSourceCompleteness,
  caseLawSourceCompleteness,
  caseLawSourceHealth,
  type CaseLawTotalReporter,
} from "@/api/handlers/case-law/decisions/coverage-health";
import {
  type CaseLawKnownGaps,
  readCaseLawCoverageYearsQuery,
} from "@/api/handlers/case-law/decisions/coverage-years";
import { readBrowseFacetsWithin } from "@/api/handlers/case-law/decisions/facets";
import {
  type CaseLawCourtStatusRow,
  caseLawCourtStatusRows,
  readCaseLawCourtActivityQuery,
  readCaseLawCourtCountQuery,
} from "@/api/handlers/case-law/decisions/status-courts";
import { coverageResponseSchema } from "@/api/handlers/case-law/public-response-schemas";
import type { SafeId } from "@/api/lib/branded-types";
import type {
  CaseLawPublicReadDb,
  CaseLawPublicReadTransaction,
} from "@/api/lib/case-law-public-read-db";
import {
  readProvisionPendingCounts,
  unavailableProvisionPendingCounts,
} from "@/api/lib/case-law/provision-pending";
import { loadPublicCourtWeightsWithin } from "@/api/lib/case-law/public-case-law-config";
import { readPendingTextCountsBySource } from "@/api/lib/case-law/public-subject";
import { redistributableCaseLawSource } from "@/api/lib/case-law/redistribution";
import { executedRows } from "@/api/lib/db/executed-rows";
import { decisionDateWithinBoundsSql } from "@/api/lib/decision-date-bounds-sql";
import { errorTag } from "@/api/lib/errors/utils";
import { ADAPTER_MANIFESTS } from "@/api/lib/legal-search/adapter-manifest";
import { CASE_LAW_SOURCE_ROWS_BOUND } from "@/api/lib/legal-search/ingestion-constants";
import {
  createUnrecognizedSourceReporter,
  SOURCE_REPORT_FEATURE,
} from "@/api/lib/legal-search/source-registry-membership";
import type { LegalBrowseFacets } from "@/api/lib/legal-search/types";
import { LIMITS } from "@/api/lib/limits";
import { failureSink } from "@/api/lib/observability/failure";
import { logger } from "@/api/lib/observability/logger";
import { observeFailure } from "@/api/lib/observability/observe-failure";
import type { PublicLawReadOptions } from "@/api/lib/public-law-read-db";
import {
  definePublicLawSharedQuery,
  PUBLIC_LAW_SHARED_QUERY,
} from "@/api/lib/public-law-shared-query";
import { projectResponseText } from "@/api/lib/search/project-response-text";
import { isRecord } from "@/api/lib/type-guards";

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

type CoverageCourt = { court: string | null; decisions: number };

/** One court feed, as a public page may describe it. */
type CaseLawCoverageSource = {
  /**
   * The adapter's key, which is also its name in the open-source registry.
   * It identifies the feed without exposing the source row's own id.
   */
  adapterKey: string;
  /** The publisher as it names itself, in its own language; never translated. */
  name: string;
  /** Where the publisher offers it, for attribution. */
  publicHomeUrl: string;
  health: CaseLawCoverageHealth;
  /** ISO 8601; null before the first run. */
  lastSyncAt: string | null;
  /** Exact decision-year bounds for decisions held from this source. */
  decisionYearFrom: number | null;
  decisionYearTo: number | null;
  /** Publisher-listed decisions whose text has not arrived. */
  pendingTextCount: number;
  /**
   * Everything the corpus holds for this source, as the ingestion side last
   * counted it; null before the first count, never a zero standing in for one.
   */
  storedDecisions: number | null;
  /** Published decisions, partitioned by deciding court in the same snapshot. */
  publishedDecisions: number;
  courts: readonly CoverageCourt[];
  /** Reconciled slice-ledger completeness by calendar year. */
  knownGaps: CaseLawKnownGaps;
  completeness: CaseLawSourceCompleteness;
  /**
   * Decisions published for this source in the last seven days; null when
   * the week's read did not answer. A zero there would be a claim the corpus
   * never made.
   */
  addedLastWeek: number | null;
};

type CaseLawCoverageCountryBase = {
  /** ISO 3166-1 alpha-3, or `EU` for the Court of Justice. */
  country: CaseLawJurisdiction;
  health: CaseLawCoverageHealth;
  /**
   * Everything the corpus holds for the country, listing-only rows included,
   * summed from what the ingestion side counted per source. `asOf` is the
   * oldest of those counts: the sum is only as current as its stalest part.
   */
  stored: { decisions: number; asOf: string | null };
  /** The sources' week summed; null as soon as one of them is unknown. */
  addedLastWeek: number | null;
  completeness: CaseLawCountryCompleteness;
  sources: readonly CaseLawCoverageSource[];
};

type CaseLawCoverageCountry =
  | (CaseLawCoverageCountryBase & {
      availability: typeof CASE_LAW_COVERAGE_AVAILABILITY.SEARCHABLE;
      /** What a public search can find: the serving index's country bucket. */
      searchable: number;
      /** Earliest and latest decision year the index holds; null when empty. */
      decisionYearFrom: number | null;
      decisionYearTo: number | null;
      /**
       * The country's courts, apex tiers named and the rest grouped; null
       * when the breakdown could not be read. An empty list means the index
       * names no court, which is a different fact.
       */
      courts: readonly CaseLawCourtStatusRow[] | null;
    })
  | (CaseLawCoverageCountryBase & {
      availability: typeof CASE_LAW_COVERAGE_AVAILABILITY.IN_PREPARATION;
    });

type CaseLawCoverage = {
  /** ISO 8601 instant the figures were computed. */
  generatedAt: string;
  /**
   * The two populations, kept apart. Summing them would count a searchable
   * decision twice and imply that an in-preparation country can be searched.
   */
  totals: {
    searchable: number;
    stored: { decisions: number; asOf: string | null };
  };
  countries: readonly CaseLawCoverageCountry[];
};

const provisionStatusReadFailure = failureSink({
  event: "case_law.coverage.provision_status_unavailable",
  expected: [],
});

const sliceCompletenessReadFailure = failureSink({
  event: "case_law.coverage.slice_completeness_unavailable",
  expected: [],
});

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
  [SOURCE_TOTAL_ORIGIN.LISTING_CENSUS]: CASE_LAW_TOTAL_REPORTER.LISTING,
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
const MANIFEST_BY_ADAPTER_KEY: ReadonlyMap<
  string,
  (typeof ADAPTER_MANIFESTS)[keyof typeof ADAPTER_MANIFESTS]
> = new Map(
  Object.values(ADAPTER_MANIFESTS).map((manifest) => [manifest.key, manifest]),
);

/**
 * The country a source row belongs to, from its adapter's manifest; null for
 * a key the registry does not know. The coverage page and the corpus status
 * both place sources through this, so they judge a country by the same set.
 */
export const caseLawSourceJurisdiction = (
  adapterKey: string,
): CaseLawJurisdiction | null => {
  const country = MANIFEST_BY_ADAPTER_KEY.get(adapterKey)?.country;
  return country !== undefined && isCaseLawJurisdiction(country)
    ? country
    : null;
};

type CaseLawCoverageSourceRow = {
  id: SafeId<"caseLawSource">;
  adapterKey: string;
  enabled: boolean;
  lastSyncAt: Date | null;
  reportedTotal: number | null;
  reportedTotalAsOf: Date | null;
  reportedTotalOrigin: string | null;
  storedTotal: number | null;
  storedTotalAsOf: Date | null;
  decisionYearFrom: number | null;
  decisionYearTo: number | null;
  pendingTextCount: number;
  courts: readonly CoverageCourt[];
  publishedDecisions: number;
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
  ): Promise<CaseLawCoverageSourceRow[]> => {
    const sources = await tx
      .select({
        id: caseLawSources.id,
        adapterKey: caseLawSources.adapterKey,
        enabled: caseLawSources.enabled,
        lastSyncAt: caseLawSources.lastSyncAt,
        reportedTotal: caseLawSources.reportedTotal,
        reportedTotalAsOf: caseLawSources.reportedTotalAsOf,
        reportedTotalOrigin: caseLawSources.reportedTotalOrigin,
        storedTotal: caseLawSources.storedTotal,
        storedTotalAsOf: caseLawSources.storedTotalAsOf,
        courts: sql<CoverageCourt[]>`coalesce((
          WITH population AS (
            SELECT f.value AS court, f.total AS decisions
            FROM ${caseLawBrowseFacetCounts} AS f
            WHERE f.kind = 'court' AND f.source_id = case_law_sources.id
            UNION ALL
            SELECT d.court, 1 AS decisions
            FROM ${publishedCaseLawDecisions} AS d
            WHERE d.source_id = case_law_sources.id
              AND NOT EXISTS (
                SELECT 1 FROM ${caseLawBrowseFacetCounts} AS source_facets
                WHERE source_facets.kind = 'court'
                  AND source_facets.source_id = case_law_sources.id
                LIMIT 1
              )
          ), normalized AS (
            SELECT nullif(btrim(court), '') AS court, decisions FROM population
          ), grouped AS (
            SELECT court, sum(decisions)::integer AS decisions
            FROM normalized GROUP BY court
          ), ranked AS (
            SELECT *, row_number() OVER (ORDER BY decisions DESC, court ASC) AS position
            FROM grouped
          ), bucketed AS (
            SELECT CASE WHEN position <= ${LIMITS.caseLawFacetLimit} THEN court END AS court,
              decisions
            FROM ranked
          ), bounded AS (
            SELECT court, sum(decisions)::integer AS decisions
            FROM bucketed GROUP BY court
          )
          SELECT jsonb_agg(jsonb_build_object('court', court, 'decisions', decisions)
            ORDER BY decisions DESC, court ASC)
          FROM bounded
        ), '[]'::jsonb)`,
        decisionYearFrom: sql<number | null>`(
          SELECT extract(year FROM coverage_decisions.decision_date)::integer
          FROM ${publishedCaseLawDecisions} AS coverage_decisions
          WHERE coverage_decisions.source_id = case_law_sources.id
            AND coverage_decisions.decision_date IS NOT NULL
            AND ${decisionDateWithinBoundsSql(
              sql`coverage_decisions.decision_date`,
              sql`coverage_decisions.country`,
            )}
          ORDER BY coverage_decisions.decision_date ASC, coverage_decisions.id ASC
          LIMIT 1
        )`,
        decisionYearTo: sql<number | null>`(
          SELECT extract(year FROM coverage_decisions.decision_date)::integer
          FROM ${publishedCaseLawDecisions} AS coverage_decisions
          WHERE coverage_decisions.source_id = case_law_sources.id
            AND coverage_decisions.decision_date IS NOT NULL
            AND ${decisionDateWithinBoundsSql(
              sql`coverage_decisions.decision_date`,
              sql`coverage_decisions.country`,
            )}
          ORDER BY coverage_decisions.decision_date DESC, coverage_decisions.id DESC
          LIMIT 1
        )`,
      })
      .from(caseLawSources)
      .where(redistributableCaseLawSource)
      .orderBy(caseLawSources.adapterKey)
      .limit(CASE_LAW_SOURCE_ROWS_BOUND);
    const counts = await readPendingTextCountsBySource(
      tx,
      sources.map(({ id }) => id),
    );
    const countsBySource = new Map(
      counts.map(({ sourceId, pendingTextCount }) => [
        sourceId,
        pendingTextCount,
      ]),
    );
    return sources.map((source) => ({
      ...source,
      pendingTextCount: countsBySource.get(source.id) ?? 0,
      publishedDecisions: source.courts.reduce(
        (total, row) => total + row.decisions,
        0,
      ),
    }));
  },
);

/** The slice ledger read failed: unknown for every source, never "no gaps". */
const UNREAD_YEAR_COMPLETENESS = {
  type: "not_reconciled",
  reason: "Slice completeness could not be read.",
} as const satisfies CaseLawKnownGaps;

/** The ledger answered but holds no reconciled slices for the source. */
const NO_YEAR_COMPLETENESS = {
  type: "not_reconciled",
  reason: "The source has no slice completeness result.",
} as const satisfies CaseLawKnownGaps;

/** A source the week's read did not answer for: unknown, never zero. */
const UNKNOWN_ARRIVALS = {
  addedLastWeek: null,
} as const satisfies Pick<CaseLawCoverageSource, "addedLastWeek">;

/**
 * A sum that is unknown as soon as one term is: adding the known terms and
 * printing the result would understate the week by exactly the sources that
 * did not answer, with nothing on the page to say so.
 */
const sumOfKnown = (terms: readonly (number | null)[]): number | null => {
  let total = 0;
  for (const term of terms) {
    if (term === null) {
      return null;
    }
    total += term;
  }
  return total;
};

/** A part of the answer that can fail without failing the page. */
export type CaseLawCoveragePart =
  | "arrivals"
  | "slice-completeness"
  | "facets"
  | "courts"
  | "provision-processing";

type CoverageLoad = {
  excludedSourceIds: readonly SafeId<"caseLawSource">[];
  /**
   * Called by every branch that answers without a part it could not read.
   * The page still answers; the caller decides what a partial answer may be
   * used for (it is never kept as the shared answer).
   */
  onPartialFailure: (part: CaseLawCoveragePart) => void;
  now: Date;
  readSources: () => Promise<CaseLawCoverageSourceRow[]>;
  /** Null when the read failed as a whole, so no source gets a number. */
  readArrivals: (
    sourceIds: readonly SafeId<"caseLawSource">[],
  ) => Promise<ReadonlyMap<string, CaseLawSourceArrivals> | null>;
  readYearCompleteness: (
    sources: readonly Pick<CaseLawCoverageSourceRow, "id" | "adapterKey">[],
  ) => Promise<ReadonlyMap<string, CaseLawKnownGaps>>;
  readFacets: (
    country: string,
  ) => Promise<Result<LegalBrowseFacets, { message: string }>>;
  readCourts: (options: {
    country: string;
    buckets: LegalBrowseFacets["court"];
    /** The country's searchable count, which the rows are made to sum to. */
    total: number;
  }) => Promise<readonly CaseLawCourtStatusRow[]>;
};

/** A read whose null means it failed; the failure is reported as it is read. */
const reportingNull = async <Value>(
  read: () => Promise<Value | null>,
  onNull: () => void,
): Promise<Value | null> => {
  const value = await read();
  if (value === null) {
    onNull();
  }
  return value;
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
  onPartialFailure,
  readArrivals,
  readCourts,
  readFacets,
  readSources,
  readYearCompleteness,
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
  const arrivals = await reportingNull(
    async () => await readArrivals(admitted.map(({ id }) => id)),
    () => onPartialFailure("arrivals"),
  );
  // Per-year completeness is a per-source detail: a failed ledger read marks
  // every source not reconciled and the rest of the page still answers.
  const yearCompleteness = await Result.tryPromise({
    try: async () => await readYearCompleteness(admitted),
    catch: coverageError("reading case-law slice completeness failed"),
  });
  if (Result.isError(yearCompleteness)) {
    onPartialFailure("slice-completeness");
    observeFailure(yearCompleteness.error, {
      sink: sliceCompletenessReadFailure,
    });
  }

  const reportUnrecognizedSource = createUnrecognizedSourceReporter(
    SOURCE_REPORT_FEATURE.coverage,
  );
  const byCountry = new Map<
    CaseLawJurisdiction,
    {
      sources: CaseLawCoverageSource[];
      stored: number;
      storedAsOf: string | null;
    }
  >();

  for (const source of admitted) {
    const manifest = MANIFEST_BY_ADAPTER_KEY.get(source.adapterKey);
    const country = caseLawSourceJurisdiction(source.adapterKey);
    if (manifest === undefined || country === null) {
      // A row whose adapter is not registered cannot be placed at all: the
      // source table carries no country of its own, and the manifest that
      // would supply one is exactly what is missing. Every figure on this
      // page hangs off a country, so the row is left out and reported rather
      // than counted into whichever country happened to be first. The
      // telemetry is the point: a key with no adapter is deployment state
      // someone has to fix, not a corpus fact a reader can act on.
      reportUnrecognizedSource(source.adapterKey);
      continue;
    }
    const sourceArrivals = arrivals?.get(String(source.id)) ?? UNKNOWN_ARRIVALS;
    const entry = byCountry.get(country) ?? {
      sources: [],
      stored: 0,
      storedAsOf: null,
    };
    entry.sources.push({
      adapterKey: source.adapterKey,
      name: manifest.publisher,
      publicHomeUrl: manifest.publicHomeUrl,
      health: caseLawSourceHealth({
        enabled: source.enabled,
        lastSyncAt: source.lastSyncAt,
        now,
      }),
      lastSyncAt: source.lastSyncAt?.toISOString() ?? null,
      decisionYearFrom: source.decisionYearFrom,
      decisionYearTo: source.decisionYearTo,
      pendingTextCount: source.pendingTextCount,
      courts: source.courts,
      publishedDecisions: source.publishedDecisions,
      storedDecisions: source.storedTotalAsOf ? source.storedTotal : null,
      knownGaps: Result.isError(yearCompleteness)
        ? UNREAD_YEAR_COMPLETENESS
        : (yearCompleteness.value.get(String(source.id)) ??
          NO_YEAR_COMPLETENESS),
      completeness: caseLawSourceCompleteness({
        reportedTotal: source.reportedTotal,
        reportedTotalAsOf: source.reportedTotalAsOf,
        reportedBy: reporterOf(source.reportedTotalOrigin),
        storedTotal: source.storedTotal,
        storedTotalAsOf: source.storedTotalAsOf,
        now,
      }),
      addedLastWeek: sourceArrivals.addedLastWeek,
    });
    // A source nobody has counted contributes nothing to the sum and says so
    // through its own completeness state, rather than adding a zero that
    // would read as "holds nothing".
    if (source.storedTotal !== null && source.storedTotalAsOf !== null) {
      const asOf = source.storedTotalAsOf.toISOString();
      entry.stored += source.storedTotal;
      entry.storedAsOf =
        entry.storedAsOf === null || asOf < entry.storedAsOf
          ? asOf
          : entry.storedAsOf;
    }
    byCountry.set(country, entry);
  }

  const countries: CaseLawCoverageCountry[] = [];
  let searchableTotal = 0;
  let storedTotal = 0;
  let storedAsOf: string | null = null;

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
      stored: { decisions: entry.stored, asOf: entry.storedAsOf },
      addedLastWeek: sumOfKnown(
        entry.sources.map(({ addedLastWeek }) => addedLastWeek),
      ),
      completeness: caseLawCountryCompleteness(
        entry.sources.map(({ completeness }) => completeness),
      ),
      sources: entry.sources,
    } satisfies CaseLawCoverageCountryBase;
    storedTotal += entry.stored;
    if (
      entry.storedAsOf !== null &&
      (storedAsOf === null || entry.storedAsOf < storedAsOf)
    ) {
      storedAsOf = entry.storedAsOf;
    }

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
      onPartialFailure("facets");
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
    const searchableSources = entry.sources.filter(
      ({ decisionYearFrom, decisionYearTo }) =>
        decisionYearFrom !== null && decisionYearTo !== null,
    );
    const from =
      searchableSources.length === 0
        ? null
        : Math.min(
            ...searchableSources.map(
              ({ decisionYearFrom }) => decisionYearFrom ?? Infinity,
            ),
          );
    const to =
      searchableSources.length === 0
        ? null
        : Math.max(
            ...searchableSources.map(
              ({ decisionYearTo }) => decisionYearTo ?? -Infinity,
            ),
          );
    const courts = await Result.tryPromise({
      try: async () =>
        await readCourts({
          country,
          buckets: facets.value.court.slice(0, LIMITS.caseLawFacetLimit),
          total: searchable,
        }),
      catch: coverageError("reading the per-court breakdown failed"),
    });
    if (Result.isError(courts)) {
      onPartialFailure("courts");
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
      courts: Result.isError(courts) ? null : courts.value,
    });
  }

  return Result.ok({
    generatedAt: now.toISOString(),
    totals: {
      searchable: searchableTotal,
      stored: { decisions: storedTotal, asOf: storedAsOf },
    },
    countries,
  });
};

type CaseLawCoverageAnswer =
  | (CaseLawCoverage & {
      provisionProcessing: Awaited<
        ReturnType<typeof readProvisionPendingCounts>
      >;
    })
  | { message: string };

/**
 * One computed answer and whether every part of it was read. `complete` is
 * false as soon as any branch of the computation answered without a part,
 * and for an unavailable answer, so neither is ever shared.
 */
export type CaseLawCoverageComputation = {
  answer: CaseLawCoverageAnswer;
  complete: boolean;
};

/** One bounded snapshot read; policy revocation is enforced inside the SQL function. */
export const readCaseLawCoverageSummaryQuery = definePublicLawSharedQuery(
  PUBLIC_LAW_SHARED_QUERY.caseLawCoverageSummary,
  async (tx: CaseLawPublicReadTransaction): Promise<CaseLawCoverageAnswer> => {
    const row = executedRows(
      await tx.execute(
        sql`SELECT public.stella_case_law_coverage_summary() AS answer`,
      ),
    ).at(0);
    if (!isRecord(row) || row["answer"] === null) {
      return { message: "Coverage is unavailable" };
    }
    const parsed = v.safeParse(coverageResponseSchema, row["answer"]);
    if (!parsed.success) {
      logger.warn("case_law.coverage.summary_invalid");
      return { message: "Coverage is unavailable" };
    }
    return parsed.output;
  },
);

/** Cold replicas read the same stored answer; requests never rebuild the corpus summary. */
export const readCaseLawCoverageHandler = async (
  caseLawDb: CaseLawPublicReadDb,
): Promise<CaseLawCoverageAnswer> =>
  await caseLawDb(readCaseLawCoverageSummaryQuery);

type CoverageAssembly = {
  load: Omit<CoverageLoad, "onPartialFailure">;
  readProvisionProcessing: () => Promise<
    Awaited<ReturnType<typeof readProvisionPendingCounts>>
  >;
};

/**
 * The answer and its completeness from one set of readers. Completeness is
 * collected from the branches that degrade, as they degrade: no separate
 * check can disagree with what the answer holds.
 */
export const assembleCaseLawCoverageAnswer = async ({
  load,
  readProvisionProcessing,
}: CoverageAssembly): Promise<CaseLawCoverageComputation> => {
  const failedParts = new Set<CaseLawCoveragePart>();
  const result = await loadCaseLawCoverage({
    ...load,
    onPartialFailure: (part) => {
      failedParts.add(part);
    },
  });
  if (Result.isError(result)) {
    // Unlike the hint beside the search box, this page IS the numbers:
    // degrading to zeros would publish a false corpus. It reports that it
    // cannot answer instead.
    logger.warn("case_law.coverage.unavailable", {
      "error.type": errorTag(result.error),
    });
    return {
      answer: { message: "Coverage is unavailable" },
      complete: false,
    };
  }

  const provisionProcessing = await Result.tryPromise({
    try: readProvisionProcessing,
    catch: coverageError("reading provision status failed"),
  });
  if (Result.isError(provisionProcessing)) {
    failedParts.add("provision-processing");
    observeFailure(provisionProcessing.error, {
      sink: provisionStatusReadFailure,
    });
  }
  return {
    answer: {
      ...result.value,
      provisionProcessing: Result.isError(provisionProcessing)
        ? unavailableProvisionPendingCounts()
        : provisionProcessing.value,
    },
    complete: failedParts.size === 0,
  };
};

export type CaseLawCoverageReadDb = <T>(
  read: (tx: CaseLawPublicReadTransaction) => Promise<T>,
  options?: PublicLawReadOptions,
) => Promise<T>;

export const computeCaseLawCoverageAnswer = async (
  caseLawDb: CaseLawCoverageReadDb,
  excludedSourceIds: readonly SafeId<"caseLawSource">[],
): Promise<CaseLawCoverageComputation> => {
  // One instant for the whole page: the freshness windows, the arrivals window
  // and `generatedAt` all describe the same moment, so a reader comparing a
  // source's last sync against the stated time is comparing like with like.
  const now = new Date();

  const computation = await assembleCaseLawCoverageAnswer({
    readProvisionProcessing: async () =>
      await caseLawDb(readProvisionPendingCounts, {
        isolation: "repeatable-read",
      }),
    load: {
      excludedSourceIds,
      now,
      readSources: async () => await caseLawDb(readCaseLawCoverageSourcesQuery),
      readYearCompleteness: async (sources) =>
        await caseLawDb(
          async (tx) => await readCaseLawCoverageYearsQuery(tx, sources),
        ),
      readArrivals: async (sourceIds) => {
        // One stored count per source, recounted by the scheduler: the week's
        // window is never walked on the request path. A failure leaves the
        // window unknown rather than failing the page: how much arrived this
        // week is the smallest claim here, and the totals beside it still answer.
        const arrivals = await Result.tryPromise({
          try: async () =>
            await caseLawDb(
              async (tx) =>
                await readCaseLawArrivalsQuery(tx, { sourceIds, now }),
            ),
          catch: coverageError("reading the week's arrivals failed"),
        });
        if (Result.isError(arrivals)) {
          logger.warn("case_law.coverage.arrivals_unavailable", {
            "error.type": errorTag(arrivals.error),
          });
          return null;
        }
        return arrivals.value;
      },
      readFacets: async (country) =>
        await caseLawDb(
          async (tx) =>
            await readBrowseFacetsWithin(tx, { country, excludedSourceIds }),
        ),
      readCourts: async ({ buckets, country, total }) => {
        const [courtWeights, activity, courtCount] = await Promise.all([
          caseLawDb(async (tx) => await loadPublicCourtWeightsWithin(tx)),
          caseLawDb(
            async (tx) =>
              await readCaseLawCourtActivityQuery(tx, {
                country,
                courts: buckets.map(({ value }) => value),
                excludedSourceIds,
                now,
              }),
          ),
          caseLawDb(
            async (tx) =>
              await readCaseLawCourtCountQuery(tx, {
                country,
                excludedSourceIds,
                engine: envBase.LEGAL_SEARCH_PROVIDER,
              }),
          ),
        ]);
        return caseLawCourtStatusRows({
          activity,
          buckets,
          country,
          courtWeights,
          courtCount,
          total,
        });
      },
    },
  });
  if (!computation.complete || "message" in computation.answer) {
    return computation;
  }
  return {
    answer: projectResponseText(computation.answer, coverageResponseSchema),
    complete: true,
  };
};
