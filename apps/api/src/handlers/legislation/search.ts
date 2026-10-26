import { panic, Result } from "better-result";
import { and, eq, getColumns, inArray, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type * as v from "valibot";

import {
  isPublicLegislationCountry,
  PUBLIC_LEGISLATION_COUNTRIES,
} from "@stll/api-contract/legislation-publication";
import {
  SEARCH_PAGINATION_COMPLETE,
  SEARCH_TOTAL_NOT_COUNTED,
  type SearchPaginationOutcome,
} from "@stll/api-contract/search";
import type { RegistryRequestObservation } from "@stll/business-registries/shared/request-observer";
import { sha256Hex as hashSha256Hex } from "@stll/sha256/bun";
import { isUuid } from "@stll/uuid-codec";

import { legislationDocuments, legislationSources } from "@/api/db/schema";
import { envBase } from "@/api/env-base";
import { projectLegislationSearchHit } from "@/api/handlers/legislation/search-response";
import {
  PUBLIC_JURISDICTIONS_DESCRIPTION,
  type SearchLegislationBody,
  searchLegislationBodySchema,
  searchLegislationResponseSchema,
  type searchLegislationSuccessResponseSchema,
} from "@/api/handlers/legislation/search-schema";
import { status } from "@/api/http/status";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
// oxlint-disable-next-line no-restricted-imports -- search boundary: brands document ids returned by the corpus index before re-hydrating from Postgres
import { toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { loadPublicFtsSearchConfigs } from "@/api/lib/case-law/public-case-law-config";
import { executedRows } from "@/api/lib/db/executed-rows";
import {
  blendedRankSql,
  noCourtTierSql,
} from "@/api/lib/legal-search/authority-sql";
import {
  type CorpusHitDispositionCounter,
  createCorpusHitDispositionCounter,
  reportCorpusHitDispositions,
} from "@/api/lib/legal-search/corpus-hit-telemetry";
import { readServingCorpusIndexGenerationTx } from "@/api/lib/legal-search/corpus-index-generation-store";
import type {
  CorpusServingGenerationAbsentError,
  ServingCorpusIndexGeneration,
} from "@/api/lib/legal-search/corpus-index-generation-store";
import { requireCorpusIndexManifest } from "@/api/lib/legal-search/corpus-index-manifest";
import {
  type CorpusCandidateRankingInput,
  readCorpusIndexSearchPage,
  SCORED_SCAN_TRANSPORT,
  type SearchCursor,
} from "@/api/lib/legal-search/corpus-index-pagination";
import {
  type CorpusAppliedProjection,
  corpusAppliedProjection,
} from "@/api/lib/legal-search/corpus-index-revision-clause";
import {
  corpusFreeTextClause,
  quoteCorpusValue,
} from "@/api/lib/legal-search/corpus-query";
import {
  partitionCorpusRehydration,
  recordCorpusRehydrationDispositions,
} from "@/api/lib/legal-search/corpus-rehydration-disposition";
import type {
  CorpusSearchCursor,
  CorpusSearchPhase,
} from "@/api/lib/legal-search/corpus-search-cursor";
import {
  corpusSearchGroupToken,
  decodeCorpusSearchCursor,
  encodeCorpusSearchCursor,
  isStaleCorpusSearchCursor,
} from "@/api/lib/legal-search/corpus-search-cursor";
import {
  DEFAULT_SEARCH_SORT,
  RELEVANCE_ORDER,
} from "@/api/lib/legal-search/corpus-search-order";
import type { FtsSearchConfig } from "@/api/lib/legal-search/fts-config";
import {
  corpusIndexId,
  corpusIndexPattern,
  isCorpusIndexJurisdiction,
} from "@/api/lib/legal-search/index-naming";
import {
  currentLegislationCorpusProjection,
  legislationCorpusAppliedRevision,
  legislationCorpusWorkCanRecur,
} from "@/api/lib/legal-search/legislation-corpus-projection";
import { isCurrentVersionOfWork } from "@/api/lib/legal-search/legislation-current-version";
import { relaxedLegislationClause } from "@/api/lib/legal-search/legislation-query";
import {
  publishedLegislationCountryFor,
  publishedLegislationDocumentFor,
  redistributableLegislationSource,
} from "@/api/lib/legal-search/legislation-redistribution";
import {
  eligibleExpression,
  inForceOn,
  inForceToday,
  type LegislationVersionRef,
  legislationVersionRef,
  legislationVersionRefAt,
  notWithdrawn,
  openedBy,
  versionSortKey,
} from "@/api/lib/legal-search/legislation-validity-window";
import {
  collapseLegislationHitsByWork,
  pinnedLegislationWorks,
  pinnedLegislationWorkScore,
  shownLegislationVersionId,
} from "@/api/lib/legal-search/legislation-work-collapse";
import type { LegislationWorkRepresentative } from "@/api/lib/legal-search/legislation-work-collapse";
import {
  legislationWorkRefKey,
  readNamedLegislationWorks,
} from "@/api/lib/legal-search/legislation-work-names";
import type {
  LegislationWorkRef,
  NamedLegislationWork,
} from "@/api/lib/legal-search/legislation-work-names";
import { NO_EXPANSION_DICTIONARY_IDENTITY } from "@/api/lib/legal-search/morphology/dictionary";
import { buildPgFtsSearchSql } from "@/api/lib/legal-search/pg-fts-query";
import { publicLawCountryUnavailable } from "@/api/lib/legal-search/public-law-country";
import {
  blendStableCitationAuthority,
  stableBlendUpperBound,
} from "@/api/lib/legal-search/rerank";
import { searchIndexUnavailableResponse } from "@/api/lib/legal-search/search-index-unavailable";
import {
  legislationPublicReadDb,
  type LegislationReadDb,
  type LegislationReadTransaction,
} from "@/api/lib/legislation-public-read-db";
import { LIMITS } from "@/api/lib/limits";
import { emitRequestStage } from "@/api/lib/observability/request-metrics";
import type {
  RequestStage,
  RequestStageOutcome,
} from "@/api/lib/observability/request-metrics";
import {
  definePublicLawSharedQuery,
  PUBLIC_LAW_SHARED_QUERY,
} from "@/api/lib/public-law-shared-query";
import { normalizeTenantPageLimit } from "@/api/lib/rate-limit/action-size-limits";
import {
  escapeAndHighlight,
  TS_HEADLINE_CONFIG,
} from "@/api/lib/search/highlight";
import { isRecord } from "@/api/lib/type-guards";

type LegislationHit = v.InferOutput<
  typeof searchLegislationSuccessResponseSchema
>["items"][number];

type RawRow = Record<string, unknown>;

type CorpusLegislationReadDependencies = {
  readPage: typeof readCorpusIndexSearchPage;
  readCandidateRows: typeof readLegislationCandidateRows;
  readNamedWorks: typeof readNamedLegislationWorks;
};

type SearchLegislationDependencies = {
  provider?: typeof envBase.LEGAL_SEARCH_PROVIDER;
  loadSearchConfigs: () => Promise<readonly FtsSearchConfig[]>;
  countryAdmission?: {
    unavailable: typeof publicLawCountryUnavailable;
    isAdmitted: typeof isPublicLegislationCountry;
  };
  readServingGeneration?: typeof readServingCorpusIndexGenerationTx;
  now?: () => number;
  emitStage?: typeof emitRequestStage;
  stageTool?: string;
  corpusSearch?: typeof corpusIndexSearch;
  corpusReads?: CorpusLegislationReadDependencies;
  projectHit?: typeof projectLegislationSearchHit;
};

type ObserveLegislationStage = <T>(
  stage: Extract<RequestStage, "candidate_hydration" | "work_collapse_ranking">,
  operation: () => Promise<T> | T,
  counts: (value: T | undefined) => {
    candidateCount?: number;
    resultCount?: number;
  },
) => Promise<T>;

const defaultSearchLegislationDependencies: SearchLegislationDependencies = {
  loadSearchConfigs: loadPublicFtsSearchConfigs,
};

const toNullableString = (x: unknown): string | null => {
  if (x === null || x === undefined) {
    return null;
  }

  if (typeof x === "string") {
    return x;
  }

  if (typeof x === "number" || typeof x === "boolean") {
    return x.toString();
  }

  if (x instanceof Date) {
    return x.toISOString();
  }

  return JSON.stringify(x);
};

const headlineRegconfig = sql`'public.stella_unaccent'::regconfig`;

const buildCorpusIndexQuery = (
  body: SearchLegislationBody,
  match: "strict" | "relaxed" = "strict",
): string | null => {
  const freeText =
    match === "strict"
      ? corpusFreeTextClause(body.query)
      : relaxedLegislationClause(body);
  if (freeText === null) {
    return null;
  }
  const clauses = [
    freeText,
    `(${PUBLIC_LEGISLATION_COUNTRIES.map((country) => `jurisdiction:${quoteCorpusValue(country)}`).join(" OR ")})`,
  ];
  if (body.documentType) {
    clauses.push(`document_type:${quoteCorpusValue(body.documentType)}`);
  }
  if (body.status) {
    clauses.push(`status:${quoteCorpusValue(body.status)}`);
  }
  if (body.source) {
    clauses.push(`source:${quoteCorpusValue(body.source)}`);
  }
  if (body.language) {
    clauses.push(`language:${quoteCorpusValue(body.language)}`);
  }
  if (body.dateFrom || body.dateTo) {
    clauses.push(
      `effective_date:[${body.dateFrom ?? "*"} TO ${body.dateTo ?? "*"}]`,
    );
  }
  return clauses.join(" AND ");
};

const extractCorpusDocumentId = (hit: Record<string, unknown>) => {
  const id = hit["document_id"];
  return typeof id === "string" && isUuid(id) ? id : null;
};

const extractCorpusSnippet = (
  snippet: Record<string, unknown> | undefined,
): string | null => {
  const text = snippet?.["text"];
  const raw = Array.isArray(text) ? text.join(" … ") : text;
  if (typeof raw !== "string" || raw.length === 0) {
    return null;
  }
  return raw.replaceAll("<b>", "<mark>").replaceAll("</b>", "</mark>");
};

type RehydrateLegislationCandidatesOptions = CorpusCandidateRankingInput & {
  body: SearchLegislationBody;
  /** The generation the hits were read from; it decides row currency. */
  generation: string;
  legislationDb: LegislationReadDb;
  /**
   * The document the page cursor names. Its Work was shown on an earlier
   * page, so it is not shown again.
   */
  cursorId?: string | undefined;
  observeStage?: ObserveLegislationStage | undefined;
  /**
   * The Works the query names, read once per request by the caller; read
   * here when absent.
   */
  namedWorks?: readonly NamedLegislationWork[] | undefined;
  /**
   * Tokens of Works earlier scan windows showed (the cursor's
   * `excludedGroups`), not shown again.
   */
  excludedWorkTokens?: readonly string[] | undefined;
  ranking?: "authority" | "lexical" | undefined;
  hitDispositions?: CorpusHitDispositionCounter | undefined;
  readCandidateRows?: typeof readLegislationCandidateRows | undefined;
};

/** Undated search keeps historical wording discoverable; an explicit date
 * restricts matches to the consolidation actually in force on that date. */
const legislationSearchWindow = (
  ref: LegislationVersionRef,
  asOf: string | undefined,
): SQL =>
  asOf === undefined
    ? openedBy(ref, sql`CURRENT_DATE`)
    : inForceOn(ref, sql`${asOf}::date`);

/** The request filters a stored version must satisfy to stand for a hit. */
const legislationRequestFilters = (body: SearchLegislationBody): SQL[] => {
  const filters: SQL[] = [
    publishedLegislationDocumentFor("search"),
    // A withdrawn version stays openable by id, never found by a search,
    // including while its index entry still waits to be erased.
    notWithdrawn(legislationVersionRef(legislationDocuments)),
    legislationSearchWindow(
      legislationVersionRef(legislationDocuments),
      body.asOf,
    ),
  ];
  if (body.jurisdiction) {
    filters.push(eq(legislationDocuments.country, body.jurisdiction));
  }
  if (body.documentType) {
    filters.push(eq(legislationDocuments.documentType, body.documentType));
  }
  if (body.status) {
    filters.push(eq(legislationDocuments.status, body.status));
  }
  if (body.source) {
    filters.push(eq(legislationDocuments.sourceId, body.source));
  }
  if (body.language) {
    filters.push(eq(legislationDocuments.language, body.language));
  }
  if (body.dateFrom) {
    filters.push(
      sql`${legislationDocuments.effectiveDate} >= ${body.dateFrom}`,
    );
  }
  if (body.dateTo) {
    filters.push(sql`${legislationDocuments.effectiveDate} <= ${body.dateTo}`);
  }
  return filters;
};

/** The columns a hit is rendered from, for a matched and a shown version alike. */
type LegislationSearchRow = {
  id: SafeId<"legislationDocument">;
  sourceId: SafeId<"legislationSource">;
  eli: string;
  slug: string | null;
  title: string;
  country: string;
  language: string;
  documentType: string | null;
  statusValue: string;
  effectiveDate: string | null;
  versionValidFrom: string | null;
  versionValidTo: string | null;
  sourceUrl: string | null;
  citationAuthority: number;
};

const documentRef = legislationVersionRef(legislationDocuments);

type LegislationWorkRepresentativesQueryOptions = {
  works: readonly LegislationWorkRef[];
  filters: readonly SQL[];
};

/**
 * Per Work, the version a hit shows: the current version when the Work has
 * one (in force today and `isCurrentVersionOfWork`, the definition the
 * listing uses), else its latest eligible version, else its latest version.
 * Only versions the request filters admit are considered.
 *
 * One seek per Work on its `(source, eli, …, language)` index through a
 * lateral join, so the read is bounded by the page's Works. Exported so the
 * plan test EXPLAINs the statement search runs.
 */
export const legislationWorkRepresentativesQuery = ({
  works,
  filters,
}: LegislationWorkRepresentativesQueryOptions): SQL => {
  const workValues = sql.join(
    works.map(
      (work) =>
        sql`(${work.sourceId}::uuid, ${work.eli}::varchar, ${work.language}::varchar)`,
    ),
    sql`, `,
  );
  return sql`
    SELECT
      r.id,
      r.source_id,
      r.eli,
      r.slug,
      r.title,
      r.country,
      r.language,
      r.document_type,
      r.status,
      r.effective_date,
      r.version_valid_from,
      r.version_valid_to,
      r.source_url,
      r.citation_authority,
      r.is_current
    FROM (VALUES ${workValues}) AS work(source_id, eli, language)
    CROSS JOIN LATERAL (
      SELECT
        ${legislationDocuments.id} AS id,
        ${legislationDocuments.sourceId} AS source_id,
        ${legislationDocuments.eli} AS eli,
        ${legislationDocuments.slug} AS slug,
        ${legislationDocuments.title} AS title,
        ${legislationDocuments.country} AS country,
        ${legislationDocuments.language} AS language,
        ${legislationDocuments.documentType} AS document_type,
        ${legislationDocuments.status} AS status,
        ${legislationDocuments.effectiveDate}::text AS effective_date,
        ${legislationDocuments.versionValidFrom}::text AS version_valid_from,
        ${legislationDocuments.versionValidTo}::text AS version_valid_to,
        ${legislationDocuments.sourceUrl} AS source_url,
        ${legislationDocuments.citationAuthority} AS citation_authority,
        (${inForceToday(documentRef)} AND ${isCurrentVersionOfWork}) AS is_current,
        ${eligibleExpression(documentRef)} AS eligible,
        ${versionSortKey(legislationDocuments.versionValidFrom)} AS sort_key
      FROM ${legislationDocuments}
      JOIN ${legislationSources}
        ON ${legislationSources.id} = ${legislationDocuments.sourceId}
      WHERE ${legislationDocuments.sourceId} = work.source_id
        AND ${legislationDocuments.eli} = work.eli
        AND ${legislationDocuments.language} = work.language
        AND ${and(...filters)}
      ORDER BY is_current DESC, eligible DESC, sort_key DESC, id DESC
      LIMIT 1
    ) AS r
  `;
};

const requireString = (row: RawRow, column: string): string => {
  const value = row[column];
  return typeof value === "string"
    ? value
    : panic(`Representative row has no ${column}`);
};

type RepresentativeRow = LegislationSearchRow & { isCurrent: boolean };

const representativeRow = (row: RawRow): RepresentativeRow => ({
  id: toSafeId<"legislationDocument">(requireString(row, "id")),
  sourceId: toSafeId<"legislationSource">(requireString(row, "source_id")),
  eli: requireString(row, "eli"),
  slug: toNullableString(row["slug"]),
  title: requireString(row, "title"),
  country: requireString(row, "country"),
  language: requireString(row, "language"),
  documentType: toNullableString(row["document_type"]),
  statusValue: requireString(row, "status"),
  effectiveDate: toNullableString(row["effective_date"]),
  versionValidFrom: toNullableString(row["version_valid_from"]),
  versionValidTo: toNullableString(row["version_valid_to"]),
  sourceUrl: toNullableString(row["source_url"]),
  citationAuthority: Number(row["citation_authority"]) || 0,
  isCurrent: row["is_current"] === true,
});

/** `legislationWorkRepresentativesQuery` read, one row per Work that has one. */
const readLegislationWorkRepresentatives = async (
  tx: LegislationReadTransaction,
  works: readonly LegislationWorkRef[],
  filters: readonly SQL[],
): Promise<RepresentativeRow[]> => {
  const unique = new Map(
    works.map((work) => [
      legislationWorkRefKey(work),
      { sourceId: work.sourceId, eli: work.eli, language: work.language },
    ]),
  );
  if (unique.size === 0) {
    return [];
  }
  return executedRows(
    await tx.execute(
      legislationWorkRepresentativesQuery({
        works: [...unique.values()],
        filters,
      }),
    ),
  ).flatMap((row) => (isRecord(row) ? [representativeRow(row)] : []));
};

/**
 * Above every blended score a scanned version can reach: a lexical score is
 * at most 1, so a named Work placed here outranks every hit the scan finds.
 */
const NAMED_WORK_SCORE_FLOOR = stableBlendUpperBound(1) + 1;

type LegislationCandidateRowsOptions = {
  ids: SafeId<"legislationDocument">[];
  generation: string;
  body: SearchLegislationBody;
};

export const legislationCandidateRowsStatement = (
  tx: LegislationReadTransaction,
  { ids, generation, body }: LegislationCandidateRowsOptions,
) => {
  const eligibleRows = tx
    .select({
      id: legislationDocuments.id,
      sourceId: legislationDocuments.sourceId,
      eli: legislationDocuments.eli,
      slug: legislationDocuments.slug,
      title: legislationDocuments.title,
      country: legislationDocuments.country,
      language: legislationDocuments.language,
      documentType: legislationDocuments.documentType,
      statusValue: legislationDocuments.status,
      effectiveDate: legislationDocuments.effectiveDate,
      versionValidFrom: legislationDocuments.versionValidFrom,
      versionValidTo: legislationDocuments.versionValidTo,
      sourceUrl: legislationDocuments.sourceUrl,
      citationAuthority: legislationDocuments.citationAuthority,
      canRecur: legislationCorpusWorkCanRecur(generation).as("can_recur"),
      // The copy a page's snippet is read from.
      appliedRevision:
        legislationCorpusAppliedRevision(generation).as("applied_revision"),
    })
    .from(legislationDocuments)
    .innerJoin(
      legislationSources,
      eq(legislationSources.id, legislationDocuments.sourceId),
    )
    .where(
      and(
        inArray(legislationDocuments.id, ids),
        ...legislationRequestFilters(body),
        currentLegislationCorpusProjection(generation),
      ),
    )
    // Bounds the content branch and keeps its subplans behind eligibility.
    .limit(ids.length)
    .as("eligible_legislation");
  return tx
    .select({ id: legislationDocuments.id, row: getColumns(eligibleRows) })
    .from(legislationDocuments)
    .leftJoin(eligibleRows, eq(legislationDocuments.id, eligibleRows.id))
    .where(inArray(legislationDocuments.id, ids))
    .limit(ids.length);
};

export const readLegislationCandidateRows = async (
  tx: LegislationReadTransaction,
  options: LegislationCandidateRowsOptions,
) =>
  partitionCorpusRehydration({
    ids: options.ids,
    records: await legislationCandidateRowsStatement(tx, options),
  });

/**
 * The production corpus-index rehydration query, exported so the reader-role
 * suite executes this exact query surface under SET ROLE.
 *
 * The matched versions are read back and blended, then folded to one hit per
 * Work (`collapseLegislationHitsByWork`), each shown as the version that
 * applies today, with the Works the query names first.
 */
export const rehydrateLegislationCandidates = async ({
  body,
  candidates,
  selectAppliedCandidates,
  generation,
  legislationDb,
  cursorId,
  namedWorks,
  excludedWorkTokens,
  ranking = "authority",
  hitDispositions = createCorpusHitDispositionCounter(),
  readCandidateRows = readLegislationCandidateRows,
  observeStage = async (_stage, operation) => await operation(),
}: RehydrateLegislationCandidatesOptions) => {
  const ids = candidates.map((candidate) =>
    toSafeId<"legislationDocument">(candidate.id),
  );
  // Reapply the request filters against the current rows: a stale corpus hit
  // (metadata changed, async re-index/delete pending) must not satisfy filters
  // it no longer matches.
  const requestFilters = legislationRequestFilters(body);
  const read = await observeStage(
    "candidate_hydration",
    async () =>
      await legislationDb(async (tx) => {
        const candidateRead =
          ids.length === 0
            ? { rows: [], dispositions: [] }
            : await readCandidateRows(tx, {
                ids,
                generation,
                body,
              });
        recordCorpusRehydrationDispositions(
          candidateRead.dispositions,
          hitDispositions,
        );
        const rows = candidateRead.rows;
        const named =
          namedWorks ??
          (await readNamedLegislationWorks(tx, {
            query: body.query,
            country: body.jurisdiction,
          }));
        const [cursorWork] =
          cursorId === undefined || !isUuid(cursorId)
            ? []
            : await tx
                .select({
                  sourceId: legislationDocuments.sourceId,
                  eli: legislationDocuments.eli,
                  language: legislationDocuments.language,
                })
                .from(legislationDocuments)
                .where(
                  eq(
                    legislationDocuments.id,
                    toSafeId<"legislationDocument">(cursorId),
                  ),
                );
        const representatives = await readLegislationWorkRepresentatives(
          tx,
          [...rows, ...named],
          requestFilters,
        );
        return { rows, named, cursorWork, representatives };
      }),
    () => ({ candidateCount: candidates.length }),
  );

  return await observeStage(
    "work_collapse_ranking",
    () => {
      const byId = new Map<string, LegislationSearchRow>(
        read.rows.map((row) => [String(row.id), row]),
      );
      const authorityById = new Map(
        read.rows.map((row) => [String(row.id), row.citationAuthority]),
      );
      const appliedById = new Map<string, CorpusAppliedProjection>();
      const manifest = requireCorpusIndexManifest("legislation", generation);
      for (const { id, appliedRevision } of read.rows) {
        if (appliedRevision !== null) {
          appliedById.set(
            String(id),
            corpusAppliedProjection(manifest, appliedRevision),
          );
        }
      }
      const revisionById = new Map(
        [...appliedById].map(([id, { revision }]) => [id, revision]),
      );
      const appliedCandidates =
        selectAppliedCandidates === undefined
          ? candidates
          : selectAppliedCandidates(appliedById);
      const rankedCandidates =
        ranking === "authority"
          ? blendStableCitationAuthority({
              candidates: appliedCandidates,
              authorityById,
            })
          : appliedCandidates.map(({ id, score }) => ({
              id,
              score,
              lexicalScore: score,
              citationAuthority: 0,
            }));
      const ranked = rankedCandidates.flatMap((hit) => {
        const row = byId.get(hit.id);
        return row === undefined
          ? []
          : [{ ...hit, work: legislationWorkRefKey(row) }];
      });
      const representatives = new Map<string, LegislationWorkRepresentative>();
      for (const { isCurrent, ...row } of read.representatives) {
        byId.set(String(row.id), row);
        representatives.set(legislationWorkRefKey(row), {
          id: String(row.id),
          isCurrent,
        });
      }

      const collapsed = collapseLegislationHitsByWork({
        ranked,
        representatives,
        // Named Works that apply today are placed first; a name only repealed or
        // not-yet-effective acts carry still places those.
        namedWorks: pinnedLegislationWorks(
          read.named.map((work) => legislationWorkRefKey(work)),
          representatives,
        ),
        namedScoreFloor: NAMED_WORK_SCORE_FLOOR,
        excludedWork:
          read.cursorWork === undefined
            ? null
            : legislationWorkRefKey(read.cursorWork),
        excludedWorkTokens: new Set(excludedWorkTokens),
      });

      const recurringTokens = new Set([
        ...read.rows
          .filter((row) => row.canRecur)
          .map((row) => corpusSearchGroupToken(legislationWorkRefKey(row))),
        // Named Works are inserted independently of physical matches on every page.
        ...read.named.map((work) =>
          corpusSearchGroupToken(legislationWorkRefKey(work)),
        ),
        ...(read.cursorWork === undefined
          ? []
          : [corpusSearchGroupToken(legislationWorkRefKey(read.cursorWork))]),
      ]);

      return {
        context: { byId },
        revisionById,
        ranked: collapsed.ranked,
        groups: collapsed.workTokens.filter((token) =>
          recurringTokens.has(token),
        ),
      };
    },
    (value) =>
      value === undefined ? {} : { resultCount: value.ranked.length },
  );
};

/** A named Work placed first on the Postgres path, with its keyset key. */
type PinnedLegislationWork = LegislationWorkRef & {
  /** The version the Work is shown as; also its keyset id. */
  keyId: SafeId<"legislationDocument">;
  score: number;
};

/**
 * Above every score the Postgres ranking gives a matched version (a text
 * rank plus a bounded authority term), so a named Work placed here comes
 * first on the Postgres path as it does on the corpus path.
 */
const PG_NAMED_WORK_SCORE_FLOOR = 1_000_000;

type LegislationSearchHitsOptions = {
  body: SearchLegislationBody;
  configs: readonly FtsSearchConfig[];
  limit: number;
  parsedCursor: SearchCursor | null;
  /** Named Works, placed by their pinned scores instead of their matches. */
  pinned: readonly PinnedLegislationWork[];
};

/**
 * The Postgres search's one statement: a page of acts plus one row that says
 * whether another page follows. Exported so the reader-role suite executes
 * this exact statement under SET ROLE.
 *
 * One row per Work: every matching version is scored, and each Work keeps its
 * best-scoring version (`DISTINCT ON` the Work key), which is the row's
 * keyset key. A named Work is placed by its pinned score and keyed by the
 * version it is shown as, and none of its matched versions stands for it
 * again. The list the keyset walks therefore holds each Work once, in an
 * order that depends on the stored rows and the query alone, so no page can
 * repeat an act another page showed.
 */
export const readLegislationSearchHits = definePublicLawSharedQuery(
  PUBLIC_LAW_SHARED_QUERY.legislationSearchHits,
  async (
    tx: LegislationReadTransaction,
    {
      body,
      configs,
      limit,
      parsedCursor,
      pinned,
    }: LegislationSearchHitsOptions,
  ): Promise<RawRow[]> => {
    const ftsSearch = buildPgFtsSearchSql({
      configs,
      query: body.query,
      refs: {
        language: sql`sd.language`,
        regconfig: sql`sd.regconfig`,
        vector: sql`sd.tsv`,
      },
    });

    const filters = sql`
    ${body.jurisdiction ? sql`AND d.country = ${body.jurisdiction}` : sql``}
    ${body.documentType ? sql`AND d.document_type = ${body.documentType}` : sql``}
    ${body.status ? sql`AND d.status = ${body.status}` : sql``}
    ${body.source ? sql`AND d.source_id = ${body.source}` : sql``}
    ${body.language ? sql`AND d.language = ${body.language}` : sql``}
    ${body.dateFrom ? sql`AND d.effective_date >= ${body.dateFrom}` : sql``}
    ${body.dateTo ? sql`AND d.effective_date <= ${body.dateTo}` : sql``}
  `;

    const scoreExpr = blendedRankSql({
      authority: sql`d.citation_authority`,
      courtTier: noCourtTierSql(),
      lexicalRank: ftsSearch.rank,
    });
    // One key for the ORDER BY and the cursor predicate alike: keyset
    // pagination is only stable while the two are the same expression.
    const cursorFilter = parsedCursor
      ? sql`WHERE (works.score, works.key_id) < (${parsedCursor.score}::float8, ${parsedCursor.id}::uuid)`
      : sql``;

    const pinnedValues =
      pinned.length === 0
        ? null
        : sql.join(
            pinned.map(
              (work) =>
                sql`(${work.sourceId}::uuid, ${work.eli}::varchar, ${work.language}::varchar, ${work.keyId}::uuid, ${work.score}::float8)`,
            ),
            sql`, `,
          );
    const pinnedWorks =
      pinnedValues === null
        ? sql``
        : sql`
      UNION ALL
      SELECT pinned.key_id, pinned.source_id, pinned.eli, pinned.language,
        pinned.score, false AS matched
      FROM (VALUES ${pinnedValues})
        AS pinned(source_id, eli, language, key_id, score)`;
    const notPinned =
      pinnedValues === null
        ? sql``
        : sql`WHERE NOT EXISTS (
          SELECT 1
          FROM (VALUES ${pinnedValues})
            AS pinned(source_id, eli, language, key_id, score)
          WHERE pinned.source_id = best.source_id
            AND pinned.eli = best.eli
            AND pinned.language = best.language
        )`;

    const result = await tx.execute(sql`
    WITH matched AS (
      SELECT sd.document_id, d.source_id, d.eli, d.language,
        ${scoreExpr} AS score
      FROM legislation_search_documents sd
      JOIN legislation_documents d ON d.id = sd.document_id
      JOIN legislation_sources
        ON legislation_sources.id = d.source_id
       AND ${redistributableLegislationSource}
      WHERE ${ftsSearch.predicate}
        AND ${publishedLegislationCountryFor(sql`d.country`, "search")}
        AND sd.retry_after IS NULL
        AND ${notWithdrawn(legislationVersionRefAt("d"))}
        AND ${legislationSearchWindow(legislationVersionRefAt("d"), body.asOf)}
        ${filters}
    ),
    best AS (
      SELECT DISTINCT ON (source_id, eli, language)
        document_id, source_id, eli, language, score
      FROM matched
      ORDER BY source_id, eli, language, score DESC, document_id DESC
    ),
    works AS (
      SELECT best.document_id AS key_id, best.source_id, best.eli,
        best.language, best.score, true AS matched
      FROM best
      ${notPinned}
      ${pinnedWorks}
    ),
    page AS (
      SELECT works.*
      FROM works
      ${cursorFilter}
      ORDER BY works.score DESC, works.key_id DESC
      LIMIT ${limit + 1}
    )
    SELECT
      page.key_id AS document_id,
      page.source_id,
      page.score,
      page.matched,
      d.eli,
      d.slug,
      d.title,
      d.country,
      d.language,
      d.document_type,
      d.status,
      d.effective_date::text AS effective_date,
      d.version_valid_from::text AS version_valid_from,
      d.version_valid_to::text AS version_valid_to,
      d.source_url,
      CASE WHEN page.matched THEN ts_headline(
        ${headlineRegconfig},
        left(
          coalesce(nullif(d.fulltext, ''), sd.searchable_text),
          ${LIMITS.searchHeadlineDocumentMaxChars}
        ),
        ${ftsSearch.headlineQuery},
        ${TS_HEADLINE_CONFIG}
      ) END AS headline
    FROM page
    JOIN legislation_documents d ON d.id = page.key_id
    LEFT JOIN legislation_search_documents sd ON sd.document_id = page.key_id
    ORDER BY page.score DESC, page.key_id DESC
  `);
    return executedRows(result).flatMap((row) => (isRecord(row) ? [row] : []));
  },
);

/** A Postgres page row: the Work's keyset key and its matched version. */
type PgWorkRow = {
  keyId: SafeId<"legislationDocument">;
  work: LegislationWorkRef;
  score: number;
  matched: boolean;
  version: LegislationSearchRow;
  headline: string | null;
};

const pgWorkRow = (row: RawRow): PgWorkRow => {
  const keyId = toSafeId<"legislationDocument">(
    requireString(row, "document_id"),
  );
  const sourceId = toSafeId<"legislationSource">(
    requireString(row, "source_id"),
  );
  const eli = requireString(row, "eli");
  const language = requireString(row, "language");
  return {
    keyId,
    work: { sourceId, eli, language },
    score: Number(row["score"]) || 0,
    matched: row["matched"] === true,
    version: {
      id: keyId,
      sourceId,
      eli,
      slug: toNullableString(row["slug"]),
      title: requireString(row, "title"),
      country: requireString(row, "country"),
      language,
      documentType: toNullableString(row["document_type"]),
      statusValue: requireString(row, "status"),
      effectiveDate: toNullableString(row["effective_date"]),
      versionValidFrom: toNullableString(row["version_valid_from"]),
      versionValidTo: toNullableString(row["version_valid_to"]),
      sourceUrl: toNullableString(row["source_url"]),
      citationAuthority: 0,
    },
    headline: toNullableString(row["headline"]),
  };
};

/**
 * The Postgres path of the same contract the corpus path keeps: one hit per
 * act, shown as the version that applies today, the acts the query names
 * first, and pages that never repeat an act. The collapse is in SQL
 * (`readLegislationSearchHits`); the named Works, the version each act is
 * shown as and the pin order come from the helpers the corpus path uses.
 */
const pgSearch = async (
  body: SearchLegislationBody,
  parsedCursor: SearchCursor | null,
  legislationDb: LegislationReadDb,
  dependencies: SearchLegislationDependencies,
): Promise<{
  hits: LegislationHit[];
  nextCursor: string | null;
  paginationOutcome: SearchPaginationOutcome;
}> => {
  const limit = normalizeTenantPageLimit(
    body.limit ?? LIMITS.caseLawSearchPageSizeDefault,
  );
  const configs = await dependencies.loadSearchConfigs();
  const requestFilters = legislationRequestFilters(body);
  const read = await legislationDb(async (tx) => {
    const named = await readNamedLegislationWorks(tx, {
      query: body.query,
      country: body.jurisdiction,
    });
    const namedRepresentatives = await readLegislationWorkRepresentatives(
      tx,
      named,
      requestFilters,
    );
    const namedByKey = new Map(
      namedRepresentatives.map((row) => [legislationWorkRefKey(row), row]),
    );
    const pinnedKeys = pinnedLegislationWorks(
      named.map((work) => legislationWorkRefKey(work)),
      new Map(
        namedRepresentatives.map((row) => [
          legislationWorkRefKey(row),
          { id: String(row.id), isCurrent: row.isCurrent },
        ]),
      ),
    );
    const pinned = pinnedKeys.flatMap((key, index): PinnedLegislationWork[] => {
      const representative = namedByKey.get(key);
      return representative === undefined
        ? []
        : [
            {
              sourceId: representative.sourceId,
              eli: representative.eli,
              language: representative.language,
              keyId: representative.id,
              score: pinnedLegislationWorkScore(
                PG_NAMED_WORK_SCORE_FLOOR,
                index,
                pinnedKeys.length,
              ),
            },
          ];
    });
    const rows = (
      await readLegislationSearchHits(tx, {
        body,
        configs,
        limit,
        parsedCursor,
        pinned,
      })
    ).map((row) => pgWorkRow(row));
    const pageRows = rows.slice(0, limit);
    const representatives = await readLegislationWorkRepresentatives(
      tx,
      pageRows.filter((row) => row.matched).map((row) => row.work),
      requestFilters,
    );
    return {
      hasMore: rows.length > limit,
      pageRows,
      representatives: [...namedRepresentatives, ...representatives],
    };
  });

  const representativeByWork = new Map(
    read.representatives.map((row) => [legislationWorkRefKey(row), row]),
  );
  const lastRow = read.pageRows.at(-1);
  const nextCursor =
    read.hasMore && lastRow
      ? encodeCorpusSearchCursor({
          score: lastRow.score,
          id: lastRow.keyId,
          windowStart: 0,
          dictionary: NO_EXPANSION_DICTIONARY_IDENTITY,
          sort: DEFAULT_SEARCH_SORT,
          target: null,
          phase: {
            type: "strict",
            fingerprint: legislationQueryFingerprint(body),
            generation: null,
          },
        })
      : null;

  const hits = read.pageRows.map((row): LegislationHit => {
    const representative = representativeByWork.get(
      legislationWorkRefKey(row.work),
    );
    const shownId = row.matched
      ? shownLegislationVersionId(
          row.keyId,
          representative === undefined
            ? undefined
            : {
                id: String(representative.id),
                isCurrent: representative.isCurrent,
              },
        )
      : row.keyId;
    const shown =
      shownId === row.keyId || representative === undefined
        ? row.version
        : representative;
    // The matched version's excerpt is shown only under that version: another
    // version's wording may not contain it.
    const headline = shown.id === row.keyId ? row.headline : null;
    return {
      match: { type: "strict" },
      documentId: shown.id,
      eli: shown.eli,
      slug: shown.slug,
      title: shown.title,
      country: shown.country,
      language: shown.language,
      documentType: shown.documentType,
      status: shown.statusValue,
      effectiveDate: shown.effectiveDate,
      versionValidFrom: shown.versionValidFrom,
      versionValidTo: shown.versionValidTo,
      sourceUrl: shown.sourceUrl,
      headline: headline ? escapeAndHighlight(headline) : null,
      score: row.score,
    };
  });
  return { hits, nextCursor, paginationOutcome: SEARCH_PAGINATION_COMPLETE };
};

export const legislationQueryFingerprint = (
  body: SearchLegislationBody,
): string =>
  hashSha256Hex(
    JSON.stringify([
      "legislation",
      body.query,
      body.jurisdiction ?? null,
      body.documentType ?? null,
      body.status ?? null,
      body.source ?? null,
      body.language ?? null,
      body.dateFrom ?? null,
      body.dateTo ?? null,
      body.asOf ?? null,
    ]),
  );

type ProjectCorpusLegislationHitOptions = {
  row: LegislationSearchRow;
  matchType: CorpusSearchPhase["type"];
  headline: string | null;
  score: number;
};

const projectCorpusLegislationHit = ({
  row,
  matchType,
  headline,
  score,
}: ProjectCorpusLegislationHitOptions): LegislationHit => ({
  match: { type: matchType },
  documentId: row.id,
  eli: row.eli,
  slug: row.slug,
  title: row.title,
  country: row.country,
  language: row.language,
  documentType: toNullableString(row.documentType),
  status: row.statusValue,
  effectiveDate: toNullableString(row.effectiveDate),
  versionValidFrom: toNullableString(row.versionValidFrom),
  versionValidTo: toNullableString(row.versionValidTo),
  sourceUrl: toNullableString(row.sourceUrl),
  headline,
  score,
});

type CorpusLegislationSearchOptions = {
  body: SearchLegislationBody;
  parsedCursor: CorpusSearchCursor | null;
  legislationDb: LegislationReadDb;
  observer: RegistryRequestObservation;
  serving: ServingCorpusIndexGeneration;
  hitDispositions: CorpusHitDispositionCounter;
  observeStage: ObserveLegislationStage;
  now: () => number;
  recordIndexScan: (
    scan: IndexScanTiming,
    outcome: RequestStageOutcome,
  ) => void;
  reads: CorpusLegislationReadDependencies;
};

type CorpusLegislationSearchResult = {
  hits: LegislationHit[];
  nextCursor: string | null;
  paginationOutcome: SearchPaginationOutcome;
};

type IndexScanTiming = {
  durationMs: number;
  candidateCount: number;
  rounds: number;
};

// Index time is everything the page read spends outside the ranking callback,
// so it pauses while candidates hydrate and rank, and the open interval is
// closed when the read settles, including a read that fails mid-round.
const createIndexRecorder = ({
  now,
  emit,
}: {
  now: () => number;
  emit: (scan: IndexScanTiming, outcome: RequestStageOutcome) => void;
}) => {
  const scan: IndexScanTiming = { durationMs: 0, candidateCount: 0, rounds: 0 };
  let rejectionAttribution:
    { type: "page_read" } | { type: "ranking_callback" } = {
    type: "page_read",
  };
  let openedAt: number | undefined = now();
  const closeInterval = () => {
    if (openedAt !== undefined) {
      scan.durationMs += now() - openedAt;
      openedAt = undefined;
    }
  };
  return {
    pause: (candidateCount: number) => {
      closeInterval();
      scan.candidateCount += candidateCount;
      scan.rounds += 1;
      return () => {
        openedAt = now();
      };
    },
    recordRankingCallbackRejection: () => {
      rejectionAttribution = { type: "ranking_callback" };
    },
    settle: (outcome: RequestStageOutcome) => {
      closeInterval();
      emit(
        scan,
        outcome === "failed" && rejectionAttribution.type === "ranking_callback"
          ? "completed"
          : outcome,
      );
    },
  };
};

// The outcome is read from the same promise without re-throwing, so the
// caller's await still receives the original rejection unchanged.
const settleIndexRead = async <T>(
  pending: Promise<T>,
  recorder: ReturnType<typeof createIndexRecorder>,
) => {
  const settlement = pending.then(
    (value) => {
      recorder.settle("completed");
      return value;
    },
    (_error: unknown) => {
      recorder.settle("failed");
      return undefined;
    },
  );
  await settlement;
  return await pending;
};

const attributeRankingCallbackRejection = async <T>(
  pending: Promise<T>,
  recorder: ReturnType<typeof createIndexRecorder>,
) => {
  await pending.then(
    () => undefined,
    (_error: unknown) => {
      recorder.recordRankingCallbackRejection();
      return undefined;
    },
  );
  return await pending;
};

type ReadCorpusPhaseOptions = {
  active: CorpusSearchPhase;
  pageLimit: number;
  cursor: SearchCursor | null;
};

const corpusIndexSearch = async ({
  body,
  parsedCursor,
  legislationDb,
  observer,
  serving,
  hitDispositions,
  observeStage,
  now,
  recordIndexScan,
  reads,
}: CorpusLegislationSearchOptions): Promise<CorpusLegislationSearchResult> => {
  const limit = normalizeTenantPageLimit(
    body.limit ?? LIMITS.caseLawSearchPageSizeDefault,
  );
  const { generation, cluster } = serving;
  const indexId = body.jurisdiction
    ? corpusIndexId(generation, body.jurisdiction)
    : corpusIndexPattern(generation);
  const fingerprint = legislationQueryFingerprint(body);
  const phase: CorpusSearchPhase = parsedCursor?.phase ?? {
    type: "strict",
    fingerprint,
    generation,
  };
  const namedWorks =
    phase.type === "relaxed"
      ? []
      : await legislationDb(
          async (tx) =>
            await reads.readNamedWorks(tx, {
              query: body.query,
              country: body.jurisdiction,
            }),
        );

  const readPhase = async ({
    active,
    pageLimit,
    cursor,
  }: ReadCorpusPhaseOptions) => {
    const query = buildCorpusIndexQuery(body, active.type);
    if (query === null) {
      return null;
    }
    const excludedWorkTokens = new Set(
      active.type === "relaxed" ? active.strictWorkTokens : [],
    );
    if (cursor?.excludedGroups !== undefined) {
      for (const token of cursor.excludedGroups) {
        excludedWorkTokens.add(token);
      }
    }
    const indexTiming = createIndexRecorder({ now, emit: recordIndexScan });
    const pending = reads.readPage({
      hitDispositions,
      observer,
      cluster,
      indexId,
      query,
      limit: pageLimit,
      order: RELEVANCE_ORDER,
      // Avoid returning full stored text for up to 300 whole-statute hits a round.
      scanTransport: SCORED_SCAN_TRANSPORT,
      parsedCursor: cursor,
      ...(active.type === "relaxed"
        ? {
            maxRounds: 1,
          }
        : {}),
      snippetFields: ["text"],
      projectionRevisionField: requireCorpusIndexManifest(
        "legislation",
        generation,
      ).projection.projectionRevisionField,
      extractId: extractCorpusDocumentId,
      extractSnippet: extractCorpusSnippet,
      unseenScoreUpperBound:
        active.type === "strict" ? stableBlendUpperBound : (score) => score,
      rankCandidates: async (candidates, { selectAppliedCandidates }) => {
        const resumeIndexTiming = indexTiming.pause(candidates.length);
        const pendingRanking = rehydrateLegislationCandidates({
          hitDispositions,
          body,
          candidates,
          selectAppliedCandidates,
          generation,
          legislationDb,
          cursorId: cursor?.id,
          namedWorks: active.type === "strict" ? namedWorks : [],
          excludedWorkTokens: [...excludedWorkTokens],
          ranking: active.type === "strict" ? "authority" : "lexical",
          observeStage,
          readCandidateRows: reads.readCandidateRows,
        });
        const ranked = await attributeRankingCallbackRejection(
          pendingRanking,
          indexTiming,
        );
        resumeIndexTiming();
        return ranked;
      },
    });
    return await settleIndexRead(pending, indexTiming);
  };

  type PhasePage = NonNullable<Awaited<ReturnType<typeof readPhase>>>;
  const hitsOf = (
    page: PhasePage,
    active: CorpusSearchPhase,
  ): LegislationHit[] =>
    page.pageRanked.flatMap((hit) => {
      const row = page.context.byId.get(hit.id);
      if (row === undefined) {
        return panic("Ranked legislation hit has no hydrated row");
      }
      return [
        projectCorpusLegislationHit({
          row,
          matchType: active.type,
          headline: page.snippetById.get(hit.id) ?? null,
          score: hit.score,
        }),
      ];
    });
  const cursorOf = (
    page: PhasePage,
    active: CorpusSearchPhase,
  ): string | null =>
    page.nextCursor === null
      ? null
      : encodeCorpusSearchCursor({
          ...page.nextCursor,
          dictionary: NO_EXPANSION_DICTIONARY_IDENTITY,
          target: null,
          phase: active,
        });
  const page = await readPhase({
    active: phase,
    pageLimit: limit,
    cursor: parsedCursor,
  });
  if (page === null) {
    return {
      hits: [],
      nextCursor: null,
      paginationOutcome: SEARCH_PAGINATION_COMPLETE,
    };
  }
  const hits = hitsOf(page, phase);
  if (
    phase.type === "relaxed" ||
    parsedCursor !== null ||
    hits.length >= limit ||
    page.nextCursor !== null ||
    page.paginationOutcome.type === "truncated"
  ) {
    return {
      hits,
      nextCursor: cursorOf(page, phase),
      paginationOutcome: page.paginationOutcome,
    };
  }
  const strictWorkTokens = [
    ...new Set(
      hits.map((hit) => {
        const row = page.context.byId.get(hit.documentId);
        return row === undefined
          ? panic("Strict legislation hit has no Work")
          : corpusSearchGroupToken(legislationWorkRefKey(row));
      }),
    ),
  ];
  const relaxed: CorpusSearchPhase = {
    type: "relaxed",
    fingerprint,
    generation,
    strictWorkTokens,
  };
  const boundary: SearchCursor = {
    score: Number.MAX_VALUE,
    id: "00000000-0000-0000-0000-000000000000",
    sort: DEFAULT_SEARCH_SORT,
    windowStart: 0,
  };
  const extra = await readPhase({
    active: relaxed,
    pageLimit: limit - hits.length,
    cursor: boundary,
  });
  if (extra === null) {
    return {
      hits,
      nextCursor: null,
      paginationOutcome: page.paginationOutcome,
    };
  }
  return {
    hits: [...hits, ...hitsOf(extra, relaxed)],
    nextCursor: cursorOf(extra, relaxed),
    paginationOutcome: extra.paginationOutcome,
  };
};

const runCorpusIndexSearch = async (
  options: CorpusLegislationSearchOptions,
  dependencies: SearchLegislationDependencies,
) => await (dependencies.corpusSearch ?? corpusIndexSearch)(options);

const defaultCorpusLegislationReads: CorpusLegislationReadDependencies = {
  readPage: readCorpusIndexSearchPage,
  readCandidateRows: readLegislationCandidateRows,
  readNamedWorks: readNamedLegislationWorks,
};

const corpusLegislationReadsOf = (
  dependencies: SearchLegislationDependencies,
): CorpusLegislationReadDependencies =>
  dependencies.corpusReads ?? defaultCorpusLegislationReads;

const projectSearchHits = (
  hits: LegislationHit[],
  dependencies: SearchLegislationDependencies,
) => hits.map(dependencies.projectHit ?? projectLegislationSearchHit);

/**
 * The serving legislation generation, or null under the pg-fts provider. No
 * serving generation is an error the handler answers with the retryable
 * search_index_unavailable 503.
 */
const readLegislationServingGeneration = async (
  legislationDb: LegislationReadDb,
  dependencies: SearchLegislationDependencies,
): Promise<
  Result<
    ServingCorpusIndexGeneration | null,
    CorpusServingGenerationAbsentError
  >
> => {
  if (
    (dependencies.provider ?? envBase.LEGAL_SEARCH_PROVIDER) !== "corpus-index"
  ) {
    return Result.ok(null);
  }
  return await legislationDb(
    async (tx) =>
      await (
        dependencies.readServingGeneration ?? readServingCorpusIndexGenerationTx
      )(tx, "legislation"),
  );
};

type AggregatedSearchStage = Extract<
  RequestStage,
  "index_scan" | "candidate_hydration" | "work_collapse_ranking"
>;

type AggregatedSearchStageCounts = {
  rounds: number;
  candidateCount: number;
  resultCount: number;
};

type EmitAggregatedSearchStage = (record: {
  stage: AggregatedSearchStage;
  durationMs: number;
  counts: AggregatedSearchStageCounts;
  outcome: RequestStageOutcome;
}) => void;

const createSearchStageAccumulator = (
  now: () => number,
  emit: EmitAggregatedSearchStage,
) => {
  const stages = new Map<
    AggregatedSearchStage,
    AggregatedSearchStageCounts & {
      durationMs: number;
      outcome: RequestStageOutcome;
    }
  >();
  const failedStages = new Set<RequestStage>();
  const valueFor = (stage: AggregatedSearchStage) =>
    stages.get(stage) ?? {
      durationMs: 0,
      rounds: 0,
      candidateCount: 0,
      resultCount: 0,
      outcome: "completed",
    };
  const observeStage: ObserveLegislationStage = async (
    stage,
    operation,
    counts,
  ) => {
    const startedAt = now();
    const pending = Promise.resolve().then(operation);
    await pending.then(
      (value) => {
        const count = counts(value);
        const accumulated = valueFor(stage);
        accumulated.durationMs += now() - startedAt;
        accumulated.rounds += 1;
        accumulated.candidateCount += count.candidateCount ?? 0;
        accumulated.resultCount += count.resultCount ?? 0;
        stages.set(stage, accumulated);
        return undefined;
      },
      (_error: unknown) => {
        failedStages.add(stage);
        const count = counts(undefined);
        const accumulated = valueFor(stage);
        accumulated.durationMs += now() - startedAt;
        accumulated.rounds += 1;
        accumulated.candidateCount += count.candidateCount ?? 0;
        accumulated.resultCount += count.resultCount ?? 0;
        accumulated.outcome = "failed";
        stages.set(stage, accumulated);
        return undefined;
      },
    );
    const value = await pending;
    return value;
  };
  const recordIndexScan = (
    scan: IndexScanTiming,
    outcome: RequestStageOutcome,
  ) => {
    const stage = "index_scan";
    const accumulated = valueFor(stage);
    accumulated.durationMs += scan.durationMs;
    accumulated.rounds += scan.rounds;
    accumulated.candidateCount += scan.candidateCount;
    if (outcome === "failed") {
      accumulated.outcome = outcome;
    }
    stages.set(stage, accumulated);
  };
  const settle = () => {
    for (const stage of [
      "index_scan",
      "candidate_hydration",
      "work_collapse_ranking",
    ] as const) {
      const accumulated = stages.get(stage);
      if (accumulated !== undefined) {
        emit({
          stage,
          durationMs: accumulated.durationMs,
          counts: accumulated,
          outcome: accumulated.outcome,
        });
      }
      if (failedStages.has(stage)) {
        break;
      }
    }
    stages.clear();
  };
  return { observeStage, recordIndexScan, settle };
};

export const searchLegislationHandler = async (
  body: SearchLegislationBody,
  legislationDb: LegislationReadDb,
  observer: RegistryRequestObservation,
  dependencies = defaultSearchLegislationDependencies,
) => {
  const now = dependencies.now ?? (() => performance.now());
  const emitStage = dependencies.emitStage ?? emitRequestStage;
  const route = "/v1/law/statutes/search";
  const beginStage = (stage: RequestStage) => ({ stage, startedAt: now() });
  const finishStage = (
    timing: { stage: RequestStage; startedAt: number },
    counts: {
      rounds?: number;
      candidateCount?: number;
      resultCount?: number;
    } = {},
    durationMs = now() - timing.startedAt,
    outcome: RequestStageOutcome = "completed",
  ) => {
    emitStage({
      route,
      ...(dependencies.stageTool === undefined
        ? {}
        : { tool: dependencies.stageTool }),
      stage: timing.stage,
      durationMs,
      ...counts,
      outcome,
    });
  };
  const stageAccumulator = createSearchStageAccumulator(
    now,
    ({ stage, durationMs, counts: accumulated, outcome }) =>
      finishStage(
        { stage, startedAt: 0 },
        {
          rounds: accumulated.rounds,
          ...(accumulated.candidateCount === 0
            ? {}
            : { candidateCount: accumulated.candidateCount }),
          ...(accumulated.resultCount === 0
            ? {}
            : { resultCount: accumulated.resultCount }),
        },
        durationMs,
        outcome,
      ),
  );
  const { observeStage, recordIndexScan } = stageAccumulator;
  const unavailable =
    body.jurisdiction === undefined
      ? null
      : (
          dependencies.countryAdmission?.unavailable ??
          publicLawCountryUnavailable
        )(body.jurisdiction, { domain: "legislation", surface: "search" });
  if (unavailable !== null) {
    return unavailable;
  }
  // source_id and the cursor id reach Postgres as UUID comparisons in the
  // pg-fts path; reject malformed values at the boundary so a bad filter
  // is a 400, not a 500 from an invalid-uuid cast.
  if (body.source !== undefined && !isUuid(body.source)) {
    return status(400, { message: "Invalid source" });
  }

  if (
    body.jurisdiction !== undefined &&
    (!isCorpusIndexJurisdiction(body.jurisdiction) ||
      !(
        dependencies.countryAdmission?.isAdmitted ?? isPublicLegislationCountry
      )(body.jurisdiction))
  ) {
    return status(400, {
      message: `Invalid jurisdiction. ${PUBLIC_JURISDICTIONS_DESCRIPTION}`,
    });
  }

  // One rejection for every way a cursor can fail to name a page of this
  // corpus, checked before either search path reads anything. A cursor that
  // names a dictionary was issued by an expanded case-law search: legislation
  // is never expanded, so its score, id and window describe a ranking of
  // other documents entirely, and applying them here would page a legislation
  // result set from a case-law boundary.
  const parsedCursor = body.cursor
    ? decodeCorpusSearchCursor(body.cursor)
    : null;
  if (
    body.cursor !== undefined &&
    (parsedCursor === null ||
      !isUuid(parsedCursor.id) ||
      parsedCursor.phase?.fingerprint !== legislationQueryFingerprint(body) ||
      isStaleCorpusSearchCursor(parsedCursor, {
        dictionary: NO_EXPANSION_DICTIONARY_IDENTITY,
        target: null,
        sort: DEFAULT_SEARCH_SORT,
        phase: parsedCursor.phase,
      }))
  ) {
    return status(400, { message: "Invalid cursor" });
  }

  const servingRead = await readLegislationServingGeneration(
    legislationDb,
    dependencies,
  );
  if (Result.isError(servingRead)) {
    return searchIndexUnavailableResponse(servingRead.error);
  }
  const serving = servingRead.value;
  let expectedPhase: CorpusSearchPhase = {
    type: "strict",
    fingerprint: legislationQueryFingerprint(body),
    generation: null,
  };
  if (serving !== null) {
    const phase = parsedCursor?.phase;
    switch (phase?.type) {
      case "relaxed":
        expectedPhase = {
          type: "relaxed",
          fingerprint: legislationQueryFingerprint(body),
          generation: serving.generation,
          strictWorkTokens: phase.strictWorkTokens,
        };
        break;
      case "strict":
      case undefined:
        expectedPhase = {
          type: "strict",
          fingerprint: legislationQueryFingerprint(body),
          generation: serving.generation,
        };
        break;
      default:
        phase satisfies never;
        return panic("Unhandled legislation cursor phase");
    }
  }
  if (
    body.cursor !== undefined &&
    isStaleCorpusSearchCursor(parsedCursor, {
      dictionary: NO_EXPANSION_DICTIONARY_IDENTITY,
      target: null,
      sort: DEFAULT_SEARCH_SORT,
      phase: expectedPhase,
    })
  ) {
    return status(400, { message: "Invalid cursor" });
  }

  const hitDispositions = createCorpusHitDispositionCounter();
  try {
    const {
      hits: items,
      nextCursor,
      paginationOutcome,
    } = serving !== null
      ? await runCorpusIndexSearch(
          {
            body,
            parsedCursor,
            legislationDb,
            observer,
            serving,
            hitDispositions,
            observeStage,
            now,
            recordIndexScan,
            reads: corpusLegislationReadsOf(dependencies),
          },
          dependencies,
        )
      : await pgSearch(body, parsedCursor, legislationDb, dependencies);

    stageAccumulator.settle();
    const serializationTiming = beginStage("response_serialization");
    const response: v.InferOutput<
      typeof searchLegislationSuccessResponseSchema
    > = {
      items: projectSearchHits(items, dependencies),
      nextCursor,
      paginationOutcome,
      total: SEARCH_TOTAL_NOT_COUNTED,
    };
    finishStage(serializationTiming, { resultCount: response.items.length });
    return response;
  } finally {
    stageAccumulator.settle();
    reportCorpusHitDispositions({
      family: "legislation",
      counts: hitDispositions.snapshot(),
    });
  }
};

const config = {
  contract: "patch",
  description:
    "Full-text search the stella legislation corpus, returning ranked results " +
    "with strict or relaxed match metadata, a highlighted snippet and each document's ELI, title, country, " +
    "language, type, status, effective date, and the matched version's validity window. " +
    "Use asOf to search the consolidation in force on an ISO date; omit it to include historical wording. Filter by jurisdiction, " +
    "document type, status, source, language, and effective-date range; " +
    `paginate with limit and cursor. ${PUBLIC_JURISDICTIONS_DESCRIPTION} Only admitted jurisdictions and sources cleared for redistribution ` +
    "are searched. Read a hit in full with legislation.read; use " +
    "legislation.boe.search to query the Spanish BOE service directly " +
    "instead.",
  permissions: { workspace: ["read"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: { type: "tool", name: "search_legislation" },
  access: "read",
  body: searchLegislationBodySchema,
  response: searchLegislationResponseSchema,
} satisfies HandlerConfig;

const searchLegislation = createSafeRootHandler(
  config,
  async function* ({ body }) {
    const response = yield* Result.await(
      Result.tryPromise(
        async () =>
          await searchLegislationHandler(
            body,
            legislationPublicReadDb,
            "unobserved",
          ),
      ),
    );
    return Result.ok(response);
  },
);

export default searchLegislation;
