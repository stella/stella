import { panic } from "better-result";
import { and, asc, desc, eq, gt, inArray, lte, sql } from "drizzle-orm";
import type { SQL, SQLWrapper } from "drizzle-orm";
import { alias, unionAll } from "drizzle-orm/pg-core";
import { status, t } from "elysia";
import type { Static } from "elysia";

import {
  CASE_LAW_CITATION_SUMMARY_SCAN_LIMIT as CITATION_SUMMARY_SCAN_LIMIT,
  CASE_LAW_CITATION_TIMELINE_MAX_YEARS,
} from "@stll/api-contract";
import { PUBLIC_CASE_LAW_COUNTRIES } from "@stll/api-contract/case-law-launch-readiness";
import type { DecisionPrimaryReferenceType } from "@stll/legal-ast/decision-identifier";
import { Temporal } from "@stll/time";

import {
  caseLawCitations,
  caseLawDecisionCitationStats,
  caseLawDecisionCitationStatsState,
  caseLawDecisions,
  caseLawSources,
} from "@/api/db/schema";
import { CITATION_KIND } from "@/api/handlers/case-law/citation-kind";
import { POLARITIES, POLARITY } from "@/api/handlers/case-law/polarity/consts";
import type { SafeId } from "@/api/lib/branded-types";
import type { CaseLawPublicReadTransaction } from "@/api/lib/case-law-public-read-db";
import {
  CITATION_DIRECTIONS,
  CITATION_TREATMENTS,
} from "@/api/lib/case-law/citation-vocabulary";
import type {
  CitationDirection,
  CitationTreatment,
} from "@/api/lib/case-law/citation-vocabulary";
import { readPublicDecisionLanguageAlternatesInTx } from "@/api/lib/case-law/language-alternates";
import type { PublicDecisionLanguageAlternate } from "@/api/lib/case-law/language-alternates";
import type { RedistributableDecisionSubject } from "@/api/lib/case-law/public-subject";
import { publishedCaseLawDecisionFor } from "@/api/lib/case-law/published-decisions";
import { redistributableCaseLawSourceFor } from "@/api/lib/case-law/redistribution";
import { tPaginationCursor } from "@/api/lib/custom-schema";
import { boundedAll } from "@/api/lib/db/bounded-all";
import { LIMITS } from "@/api/lib/limits";
import { logger } from "@/api/lib/observability/logger";
import {
  decodePaginationCursor,
  encodePaginationCursor,
  isUuidPaginationCursorPart,
  type Page,
} from "@/api/lib/pagination";
import { PUBLIC_LAW_COLUMN_GRANTS_BY_RELATION } from "@/api/lib/public-law-relations";
import { normalizeTenantPageLimit } from "@/api/lib/rate-limit/action-size-limits";
import { brandPersistedCaseLawCitationId } from "@/api/lib/safe-id-boundaries";
import { includes } from "@/api/lib/type-guards";

/**
 * The stored polarity as the display reads it. Null (never classified) and
 * `unknown` (classified, no answer) are both the absence of a reading, so
 * both answer `unclassified` rather than posing as a neutral one.
 */
export const treatmentOf = (polarity: string | null): CitationTreatment => {
  if (polarity === null || !includes(POLARITIES, polarity)) {
    return "unclassified";
  }
  return polarity === POLARITY.UNKNOWN ? "unclassified" : polarity;
};

export const listDecisionCitationsQuerySchema = t.Object({
  direction: t.UnionEnum(CITATION_DIRECTIONS),
  cursor: t.Optional(tPaginationCursor()),
});

type ListDecisionCitationsQuery = Static<
  typeof listDecisionCitationsQuerySchema
>;

/** The decision at the far end of a citation, enough to address its page. */
type RelatedDecision = {
  id: SafeId<"caseLawDecision">;
  caseNumber: string;
  /** What kind of reference `caseNumber` is. */
  caseNumberType: DecisionPrimaryReferenceType;
  country: string;
  court: string;
  decisionDate: string | null;
  /**
   * Type and ECLI distinguish the documents that share one docket number
   * (a nález and the orders in its file); without them two rows read alike.
   */
  decisionType: string | null;
  ecli: string | null;
  language: string;
  /** Every language version, which decides whether its route names one. */
  languageAlternates: readonly PublicDecisionLanguageAlternate[];
  slug: string | null;
};

/**
 * The same decision with the materialized `ln(1 + weighted citations)` score
 * the query read for it. Search ranks by that score too, so a reader weighing
 * "who cites this" sees the weight the result list gave those courts. Kept
 * beside `RelatedDecision` rather than inside it: addressing a decision's page
 * needs none of it, and the reader surfaces that only address one would have
 * to invent a number.
 */
export type RankedRelatedDecision = RelatedDecision & {
  citationAuthority: number;
};

/** The far decision as a graph query selects it, before its versions are read. */
type RankedRelatedDecisionRow = Omit<
  RankedRelatedDecision,
  "languageAlternates"
> & { languageGroupKey: string | null };

/**
 * The far decisions' language versions, one read for the whole page, so a
 * row's route carries the language segment the decision's own page uses.
 */
const withLanguageAlternates = async (
  tx: CaseLawPublicReadTransaction,
  decisions: readonly (RankedRelatedDecisionRow | null)[],
): Promise<(row: RankedRelatedDecisionRow) => RankedRelatedDecision> => {
  const alternates = await readPublicDecisionLanguageAlternatesInTx(
    tx,
    decisions.map((decision) => decision?.languageGroupKey ?? null),
  );
  return ({ languageGroupKey, ...decision }) =>
    Object.assign(decision, {
      languageAlternates: alternates.alternatesFor(languageGroupKey),
    });
};

export type DecisionCitationRow = {
  id: SafeId<"caseLawCitation">;
  citationText: string;
  sectionIndex: number | null;
  treatment: CitationTreatment;
  /**
   * Null only for an outgoing citation the corpus could not resolve to a
   * held decision; such a row is text and nothing more. An incoming citation
   * is by construction resolved, so its decision is always present.
   */
  decision: RankedRelatedDecision | null;
};

/** The decision at the far end of the citation, whichever way it points. */
const relatedDecision = alias(caseLawDecisions, "graph_related_decision");
const relatedSource = alias(caseLawSources, "graph_related_source");

const decodeCitationCursor = (
  cursor: string | undefined,
): SafeId<"caseLawCitation"> | null | undefined => {
  if (cursor === undefined) {
    return undefined;
  }

  const parts = decodePaginationCursor(cursor);
  const id = parts?.at(0);
  if (parts?.length !== 1 || !isUuidPaginationCursorPart(id)) {
    return null;
  }

  return brandPersistedCaseLawCitationId(id);
};

type ScannedRow = {
  id: SafeId<"caseLawCitation">;
  citationText: string;
  sectionIndex: number | null;
  polarity: string | null;
  visible: boolean;
  decision: RankedRelatedDecisionRow | null;
};

type CreateScannedPageOptions = {
  rows: readonly ScannedRow[];
  limit: number;
  toRelatedDecision: (row: RankedRelatedDecisionRow) => RankedRelatedDecision;
};

/**
 * The page keeps the scan's own boundary: the cursor advances over every
 * examined row, visible or not, so a run of hidden rows can never stall it,
 * and a page may legitimately hold fewer than `limit` items.
 */
const createScannedPage = ({
  rows,
  limit,
  toRelatedDecision,
}: CreateScannedPageOptions): Page<DecisionCitationRow> => {
  const scanned = rows.slice(0, limit);
  const items: DecisionCitationRow[] = [];
  for (const row of scanned) {
    if (!row.visible) {
      continue;
    }
    items.push({
      id: row.id,
      citationText: row.citationText,
      sectionIndex: row.sectionIndex,
      treatment: treatmentOf(row.polarity),
      decision: row.decision === null ? null : toRelatedDecision(row.decision),
    });
  }
  const lastScanned = scanned.at(-1);

  return {
    items,
    limit,
    nextCursor:
      rows.length > limit && lastScanned !== undefined
        ? encodePaginationCursor([lastScanned.id])
        : null,
  };
};

type CitationEndpointColumn =
  | typeof caseLawCitations.citedDecisionId
  | typeof caseLawCitations.citingDecisionId;

type DirectionSpec = {
  /** The column that anchors the scan to the decision being read. */
  anchor: CitationEndpointColumn;
  /** The column that names the decision at the far end. */
  related: CitationEndpointColumn;
  /** Whether an unresolved row (no far end) still belongs to the reader. */
  keepsUnresolved: boolean;
};

const DIRECTION_SPECS = {
  incoming: {
    anchor: caseLawCitations.citedDecisionId,
    related: caseLawCitations.citingDecisionId,
    keepsUnresolved: false,
  },
  outgoing: {
    anchor: caseLawCitations.citingDecisionId,
    related: caseLawCitations.citedDecisionId,
    keepsUnresolved: true,
  },
} as const satisfies Record<CitationDirection, DirectionSpec>;

/**
 * A row the reader may see: its far end is a held decision from a source that
 * allows redistribution, published rather than listing-only, in a public
 * country; or (outgoing only) there is no far end to protect.
 *
 * The one gate for every related-decision read in this module: the list, the
 * summary and the leading rows all filter through it, so a new disposition
 * reaches them together. `case-law-public-route-invariants.test.ts` holds the
 * module to it.
 */
const visibleFor = ({
  keepsUnresolved,
  related,
  farEnd,
}: {
  keepsUnresolved: boolean;
  farEnd: "decision" | "projection";
  /** The far-end id as the enclosing query can see it. */
  related: SQLWrapper;
}): SQL<boolean> => {
  const visibility = (() => {
    switch (farEnd) {
      case "decision":
        return {
          country: relatedDecision.country,
          published: publishedCaseLawDecisionFor(relatedDecision.metadata),
        };
      case "projection":
        // The trigger projection contains only published far endpoints.
        return {
          country: caseLawDecisionCitationStats.relatedCountry,
          published: sql`true`,
        };
      default:
        farEnd satisfies never;
        return panic("Unhandled citation visibility input");
    }
  })();
  const resolvedAndOpen = sql`(
    ${relatedSource.id} IS NOT NULL
    AND ${redistributableCaseLawSourceFor(relatedSource.descriptor)}
    AND ${visibility.published}
    AND ${inArray(visibility.country, [...PUBLIC_CASE_LAW_COUNTRIES])}
  )`;
  return keepsUnresolved
    ? sql<boolean>`(${related} IS NULL OR ${resolvedAndOpen})`
    : sql<boolean>`${resolvedAndOpen}`;
};

/**
 * Only precedent citations draw the graph: a reference to the judgment under
 * review names the case's own history, not an authority it relies on.
 */
const precedentOnly = eq(caseLawCitations.kind, CITATION_KIND.PRECEDENT);

type ListDecisionCitationsOptions = {
  /**
   * Gated upstream, and the only database handle this read gets: its rows
   * come from the transaction that approved it.
   */
  subject: RedistributableDecisionSubject;
  query: ListDecisionCitationsQuery;
  /**
   * Rows to scan for this page. Capped at the shared page size, which is what
   * the reader surface asks for and what the indexes are sized against; an
   * agent asking for fewer pays for fewer.
   */
  limit?: number;
};

export const listDecisionCitationsHandler = async ({
  subject: { id: decisionId, tx },
  query,
  limit = LIMITS.caseLawDecisionCitationPageSize,
}: ListDecisionCitationsOptions) => {
  const cursorId = decodeCitationCursor(query.cursor);
  if (cursorId === null) {
    return status(400, { message: "Invalid cursor" });
  }
  const pageSize = normalizeTenantPageLimit(
    Math.min(limit, LIMITS.caseLawDecisionCitationPageSize),
  );
  const rows = await decisionCitationPageQuery({
    cursorId,
    decisionId,
    direction: query.direction,
    limit: pageSize,
    tx,
  });
  const toRelatedDecision = await withLanguageAlternates(
    tx,
    rows.map((row) => (row.visible ? row.decision : null)),
  );

  return createScannedPage({ rows, limit: pageSize, toRelatedDecision });
};

type DecisionCitationPageQueryOptions = {
  cursorId: SafeId<"caseLawCitation"> | undefined;
  decisionId: SafeId<"caseLawDecision">;
  direction: CitationDirection;
  limit: number;
  tx: CaseLawPublicReadTransaction;
};

export const decisionCitationPageQuery = ({
  cursorId,
  decisionId,
  direction,
  limit,
  tx,
}: DecisionCitationPageQueryOptions) => {
  const spec = DIRECTION_SPECS[direction];

  const candidates = tx
    .select({
      id: caseLawCitations.id,
      citationText: caseLawCitations.citationText,
      relatedId: spec.related,
      sectionIndex: caseLawCitations.sectionIndex,
      polarity: caseLawCitations.polarity,
    })
    .from(caseLawCitations)
    .where(
      and(
        sql`${spec.anchor} = ${decisionId}`,
        precedentOnly,
        cursorId === undefined ? undefined : gt(caseLawCitations.id, cursorId),
      ),
    )
    .orderBy(asc(caseLawCitations.id))
    .limit(limit + 1)
    .as("citation_graph_candidates");
  return tx
    .select({
      id: candidates.id,
      citationText: candidates.citationText,
      sectionIndex: candidates.sectionIndex,
      polarity: candidates.polarity,
      visible: visibleFor({
        farEnd: "decision",
        keepsUnresolved: spec.keepsUnresolved,
        related: candidates.relatedId,
      }),
      decision: {
        id: relatedDecision.id,
        caseNumber: relatedDecision.caseNumber,
        caseNumberType: relatedDecision.caseNumberType,
        country: relatedDecision.country,
        court: relatedDecision.court,
        decisionDate: relatedDecision.decisionDate,
        decisionType: relatedDecision.decisionType,
        ecli: relatedDecision.ecli,
        language: relatedDecision.language,
        languageGroupKey: relatedDecision.languageGroupKey,
        slug: relatedDecision.slug,
        citationAuthority: relatedDecision.citationAuthority,
      },
    })
    .from(candidates)
    .leftJoin(relatedDecision, eq(relatedDecision.id, candidates.relatedId))
    .leftJoin(relatedSource, eq(relatedSource.id, relatedDecision.sourceId))
    .orderBy(asc(candidates.id))
    .limit(limit + 1);
};

export type CitationTreatmentCounts = Record<CitationTreatment, number>;

export type CitationYearCounts = CitationTreatmentCounts & { year: number };

/** How far back the per-year rollup reaches, counted to the current year. */
export const CITATION_TIMELINE_MAX_YEARS = CASE_LAW_CITATION_TIMELINE_MAX_YEARS;

export { CASE_LAW_CITATION_SUMMARY_SCAN_LIMIT as CITATION_SUMMARY_SCAN_LIMIT } from "@stll/api-contract";

const emptyTreatmentCounts = (): CitationTreatmentCounts => ({
  negative: 0,
  neutral: 0,
  positive: 0,
  supportive: 0,
  mixed: 0,
  unclassified: 0,
});

type SummarizeDecisionCitationsOptions = {
  /**
   * Gated upstream, and the only database handle this read gets: its rows
   * come from the transaction that approved it.
   */
  subject: RedistributableDecisionSubject;
  /** The year the timeline ends; injectable so a test can pin it. */
  currentYear?: number;
};

type SummaryRow = {
  direction: CitationDirection;
  /**
   * The citing decision's year for an incoming row inside the timeline span;
   * null for an outgoing row, and for an incoming row whose citing decision
   * is undated or older than the span. Such rows still count toward the
   * direction's totals, so the totals and the list agree even when the
   * timeline cannot place them.
   */
  year: number | null;
  polarity: string | null;
  count: number;
  capped: boolean;
};

type DecisionCitationSummaryQueryOptions = {
  currentYear: number;
  decisionId: SafeId<"caseLawDecision">;
  tx: CaseLawPublicReadTransaction;
};

export const decisionCitationStatsStateQuery = ({
  tx,
  decisionId,
}: Pick<DecisionCitationSummaryQueryOptions, "tx" | "decisionId">) =>
  tx
    .select({ status: caseLawDecisionCitationStatsState.status })
    .from(caseLawDecisionCitationStatsState)
    .where(eq(caseLawDecisionCitationStatsState.decisionId, decisionId))
    .limit(1);

/**
 * Deploy safety: older API releases attest against their own column maps and
 * reject grants on these new relations as excess privilege. Keep the migration
 * grant-free until #4962 is deployed. Remove this probe in the following
 * citation-stats-reader-grant release, together with its column-grant migration.
 */
const canReadDecisionCitationStats = async (
  tx: CaseLawPublicReadTransaction,
) => {
  const permissions = [
    [
      "case_law_decision_citation_stats",
      PUBLIC_LAW_COLUMN_GRANTS_BY_RELATION.case_law_decision_citation_stats,
    ],
    [
      "case_law_decision_citation_stats_state",
      PUBLIC_LAW_COLUMN_GRANTS_BY_RELATION.case_law_decision_citation_stats_state,
    ],
  ] as const;
  const predicates = permissions.flatMap(([relation, columns]) =>
    Object.keys(columns).map(
      (column) =>
        sql`has_column_privilege(current_user, ${`public.${relation}`}, ${column}, 'SELECT')`,
    ),
  );
  const rows = await tx
    .select({ available: sql<boolean>`${sql.join(predicates, sql` AND `)}` })
    .from(sql`(SELECT 1) AS citation_stats_permission_probe`);
  return (
    rows.at(0) ?? panic("Citation stats permission query returned no result")
  ).available;
};

/** Incoming years plus undated incoming/outgoing, each with a stored polarity. */
export const EXACT_CITATION_SUMMARY_MAX_ROWS =
  (CITATION_TIMELINE_MAX_YEARS + 2) * POLARITIES.length;

/** A SUM over projection buckets, independent of the decision's edge count. */
export const exactDecisionCitationSummaryQuery = ({
  limit,
  currentYear,
  decisionId,
  tx,
}: DecisionCitationSummaryQueryOptions & { limit: number }) => {
  const stats = caseLawDecisionCitationStats;
  const firstYear = currentYear - (CITATION_TIMELINE_MAX_YEARS - 1);
  const year = sql<number | null>`CASE WHEN ${stats.direction} = 'incoming'
    AND ${stats.relatedYear} BETWEEN ${firstYear} AND ${currentYear}
    THEN ${stats.relatedYear} END`;
  return tx
    .select({
      direction: stats.direction,
      year: year.as("year"),
      polarity: stats.polarity,
      count: sql<number>`coalesce(sum(${stats.count}), 0)::double precision`.as(
        "count",
      ),
      capped: sql<boolean>`false`.as("capped"),
    })
    .from(stats)
    .leftJoin(relatedSource, eq(relatedSource.id, stats.relatedSourceId))
    .where(
      and(
        eq(stats.decisionId, decisionId),
        visibleFor({
          farEnd: "projection",
          keepsUnresolved: true,
          related: stats.relatedSourceId,
        }),
      ),
    )
    .groupBy(stats.direction, sql`2`, stats.polarity)
    .limit(limit);
};

/**
 * How many precedent citations each direction holds, by treatment, and the
 * incoming ones by year.
 *
 * Counts only what the list would show, so the rollup and the rows agree:
 * a citation whose far end may not be redistributed is absent from both.
 * Exact projections serve totals and the timeline after per-decision backfill.
 * Pending projections keep the bounded edge scan and advertise lower bounds.
 */
export const summarizeDecisionCitationsHandler = async ({
  subject: { id: decisionId, tx },
  currentYear = Temporal.Now.plainDateISO("UTC").year,
}: SummarizeDecisionCitationsOptions) => {
  const canReadStats = await canReadDecisionCitationStats(tx);
  if (!canReadStats) {
    logger.warn("case_law.citation_stats.bounded_fallback", {
      reason: "reader_grant_pending",
    });
  }
  const state = canReadStats
    ? await decisionCitationStatsStateQuery({ tx, decisionId })
    : [];
  const isExact = state.at(0)?.status === "exact";
  const rows = isExact
    ? await boundedAll({
        invariant:
          "citation direction/year grouping and stored polarity domain",
        max: EXACT_CITATION_SUMMARY_MAX_ROWS,
        table: "case_law_decision_citation_stats",
        query: (limit) =>
          exactDecisionCitationSummaryQuery({
            currentYear,
            decisionId,
            tx,
            limit,
          }),
      })
    : await decisionCitationSummaryQuery({ currentYear, decisionId, tx })
        .summary;

  const totals: Record<CitationDirection, CitationTreatmentCounts> = {
    incoming: emptyTreatmentCounts(),
    outgoing: emptyTreatmentCounts(),
  };
  const capped: Record<CitationDirection, boolean> = {
    incoming: false,
    outgoing: false,
  };
  const byYear = new Map<number, CitationYearCounts>();
  for (const row of rows satisfies readonly SummaryRow[]) {
    capped[row.direction] ||= row.capped;
    if (row.count === 0) {
      continue;
    }
    const treatment = treatmentOf(row.polarity);
    totals[row.direction][treatment] += row.count;
    if (row.year === null) {
      continue;
    }
    const counts = byYear.get(row.year) ?? {
      ...emptyTreatmentCounts(),
      year: row.year,
    };
    counts[treatment] += row.count;
    byYear.set(row.year, counts);
  }

  const summary = {
    incoming: totals.incoming,
    outgoing: totals.outgoing,
    incomingByYear: [...byYear.values()].toSorted((a, b) => a.year - b.year),
  };
  const precision = isExact
    ? { status: "exact" as const }
    : { status: "bounded" as const, capped };
  return {
    ...summary,
    precision,
  };
};

export type DecisionCitationSummary = Awaited<
  ReturnType<typeof summarizeDecisionCitationsHandler>
>;

/**
 * The bounded summary and top-citer ranking share the raw incoming window.
 * Ranking precision is independent of the summary's projection precision:
 * non-precedent and hidden edges still occupy places in this window.
 */
export const decisionCitationSummaryQuery = ({
  currentYear,
  decisionId,
  tx,
}: DecisionCitationSummaryQueryOptions) => {
  const candidatesFor = (direction: CitationDirection) => {
    const spec = DIRECTION_SPECS[direction];
    const candidates = tx
      .select({
        id: caseLawCitations.id,
        relatedId: spec.related,
        polarity: caseLawCitations.polarity,
        kind: caseLawCitations.kind,
      })
      .from(caseLawCitations)
      .where(eq(spec.anchor, decisionId))
      .orderBy(asc(caseLawCitations.id))
      .limit(CITATION_SUMMARY_SCAN_LIMIT + 1)
      .as(`${direction}_summary_candidates`);
    return tx
      .select({
        relatedId: candidates.relatedId,
        polarity: candidates.polarity,
        kind: candidates.kind,
        ordinal: sql<number>`row_number() OVER (ORDER BY ${candidates.id})`.as(
          "ordinal",
        ),
      })
      .from(candidates)
      .as(`${direction}_summary_numbered`);
  };

  const firstYear = currentYear - (CITATION_TIMELINE_MAX_YEARS - 1);
  const citingYearInSpan = sql<number | null>`CASE
    WHEN ${relatedDecision.decisionDate} >= make_date(${firstYear}::int, 1, 1)
     AND ${relatedDecision.decisionDate} < make_date(${currentYear + 1}::int, 1, 1)
    THEN extract(year from ${relatedDecision.decisionDate})::int
  END`;
  const incomingCandidates = candidatesFor("incoming");
  const incomingVisible = visibleFor({
    farEnd: "decision",
    keepsUnresolved: false,
    related: incomingCandidates.relatedId,
  });

  const incoming = tx
    .select({
      direction: sql<CitationDirection>`'incoming'`.as("direction"),
      year: citingYearInSpan.as("year"),
      polarity: incomingCandidates.polarity,
      count:
        sql<number>`count(*) FILTER (WHERE ${incomingCandidates.ordinal} <= ${CITATION_SUMMARY_SCAN_LIMIT} AND ${eq(incomingCandidates.kind, CITATION_KIND.PRECEDENT)} AND ${incomingVisible})::int`.as(
          "count",
        ),
      capped:
        sql<boolean>`bool_or(${incomingCandidates.ordinal} > ${CITATION_SUMMARY_SCAN_LIMIT})`.as(
          "capped",
        ),
    })
    .from(incomingCandidates)
    .leftJoin(
      relatedDecision,
      eq(relatedDecision.id, incomingCandidates.relatedId),
    )
    .leftJoin(relatedSource, eq(relatedSource.id, relatedDecision.sourceId))
    // By ordinal: the year expression binds its bounds as parameters, and
    // a second rendering would bind fresh ones the planner cannot match.
    .groupBy(sql`2`, incomingCandidates.polarity);

  const outgoingCandidates = candidatesFor("outgoing");
  const outgoingVisible = visibleFor({
    farEnd: "decision",
    keepsUnresolved: true,
    related: outgoingCandidates.relatedId,
  });

  const outgoing = tx
    .select({
      direction: sql<CitationDirection>`'outgoing'`.as("direction"),
      year: sql<number | null>`NULL::int`.as("year"),
      polarity: outgoingCandidates.polarity,
      count:
        sql<number>`count(*) FILTER (WHERE ${outgoingCandidates.ordinal} <= ${CITATION_SUMMARY_SCAN_LIMIT} AND ${eq(outgoingCandidates.kind, CITATION_KIND.PRECEDENT)} AND ${outgoingVisible})::int`.as(
          "count",
        ),
      capped:
        sql<boolean>`bool_or(${outgoingCandidates.ordinal} > ${CITATION_SUMMARY_SCAN_LIMIT})`.as(
          "capped",
        ),
    })
    .from(outgoingCandidates)
    .leftJoin(
      relatedDecision,
      eq(relatedDecision.id, outgoingCandidates.relatedId),
    )
    .leftJoin(relatedSource, eq(relatedSource.id, relatedDecision.sourceId))
    .groupBy(outgoingCandidates.polarity);

  /**
   * The few decisions citing this one a reader should see first, one row per
   * decision however often it cites the case: the most authoritative by the
   * materialized citation authority search ranks by, the most recent among
   * equals. Only citations the counts above count take part.
   */
  const topCiting = (limit: number) => {
    const candidates = candidatesFor("incoming");
    const citedBy = eq(relatedDecision.id, candidates.relatedId);
    const publishedBy = eq(relatedSource.id, relatedDecision.sourceId);
    return (
      tx
        .select({
          id: relatedDecision.id,
          caseNumber: relatedDecision.caseNumber,
          caseNumberType: relatedDecision.caseNumberType,
          country: relatedDecision.country,
          court: relatedDecision.court,
          decisionDate: relatedDecision.decisionDate,
          decisionType: relatedDecision.decisionType,
          ecli: relatedDecision.ecli,
          language: relatedDecision.language,
          languageGroupKey: relatedDecision.languageGroupKey,
          slug: relatedDecision.slug,
          citationAuthority: relatedDecision.citationAuthority,
        })
        .from(candidates)
        .innerJoin(relatedDecision, citedBy)
        .innerJoin(relatedSource, publishedBy)
        .where(
          and(
            lte(candidates.ordinal, CITATION_SUMMARY_SCAN_LIMIT),
            eq(candidates.kind, CITATION_KIND.PRECEDENT),
            visibleFor({
              farEnd: "decision",
              keepsUnresolved: false,
              related: candidates.relatedId,
            }),
          ),
        )
        // Grouped by the far decision's key, so its other columns are
        // functionally dependent and one decision is one row.
        .groupBy(relatedDecision.id)
        .orderBy(
          desc(relatedDecision.citationAuthority),
          sql`${relatedDecision.decisionDate} DESC NULLS LAST`,
          asc(relatedDecision.id),
        )
        .limit(limit)
    );
  };

  return {
    // One row per (direction, year-or-null, stored polarity): the span and
    // the polarity check constraint already cap it, this states the cap.
    summary: unionAll(incoming, outgoing).limit(
      (CITATION_TIMELINE_MAX_YEARS + 2) * (POLARITIES.length + 1),
    ),
    topCiting,
    incomingWindowOverflow: tx
      .select({ ordinal: incomingCandidates.ordinal })
      .from(incomingCandidates)
      .where(gt(incomingCandidates.ordinal, CITATION_SUMMARY_SCAN_LIMIT))
      .limit(1),
  };
};

type TopCitingDecisionsOptions = {
  subject: RedistributableDecisionSubject;
  /** Read in the subject's transaction; reused by the digest. */
  summary: DecisionCitationSummary;
  /** Distinct citing decisions to return. */
  limit: number;
};

/**
 * The year the summary statement's timeline would end on. The top citers
 * read none of the timeline, so any year builds the same ranking; a fixed
 * one keeps this read free of a clock it has no use for.
 */
const TOP_CITING_TIMELINE_YEAR = 0;

export type TopCitingDecisionsResult = { items: RankedRelatedDecision[] } & (
  | { precision: "exact" }
  | {
      precision: "bounded";
      candidateWindow: typeof CITATION_SUMMARY_SCAN_LIMIT;
    }
);

/**
 * The top citing decisions, ranked within the raw incoming candidate window.
 * Unlike `listLeadingCitationsHandler` it is not split by treatment, so a
 * decision cited mostly one way still names `limit` citing decisions.
 */
export const listTopCitingDecisionsHandler = async ({
  subject: { id: decisionId, tx },
  summary,
  limit,
}: TopCitingDecisionsOptions): Promise<TopCitingDecisionsResult> => {
  const query = decisionCitationSummaryQuery({
    currentYear: TOP_CITING_TIMELINE_YEAR,
    decisionId,
    tx,
  });
  const rows = await query.topCiting(limit);
  const toRelatedDecision = await withLanguageAlternates(tx, rows);
  const items = rows.map((row) => toRelatedDecision(row));
  const incomingTotal = Object.values(summary.incoming).reduce(
    (total, count) => total + count,
    0,
  );
  if (
    summary.precision.status !== "exact" ||
    incomingTotal > CITATION_SUMMARY_SCAN_LIMIT
  ) {
    return {
      items,
      precision: "bounded",
      candidateWindow: CITATION_SUMMARY_SCAN_LIMIT,
    };
  }
  // A filtered projection total cannot account for hidden or procedural edges
  // occupying the raw window. A sentinel keeps those cases bounded too.
  const overflow = await query.incomingWindowOverflow;
  if (overflow.length > 0) {
    return {
      items,
      precision: "bounded",
      candidateWindow: CITATION_SUMMARY_SCAN_LIMIT,
    };
  }
  return { items, precision: "exact" };
};

/** How many decisions each treatment shows before the reader asks for all. */
export const LEADING_CITATIONS_PER_TREATMENT = 3;

export const listLeadingCitationsQuerySchema = t.Object({
  direction: t.UnionEnum(CITATION_DIRECTIONS),
});

type ListLeadingCitationsQuery = Static<typeof listLeadingCitationsQuerySchema>;

export type LeadingCitationRow = {
  id: SafeId<"caseLawCitation">;
  citationText: string;
  sectionIndex: number | null;
  treatment: CitationTreatment;
  /** Resolved by construction: only a held decision can lead. */
  decision: RankedRelatedDecision;
};

type ListLeadingCitationsOptions = {
  subject: RedistributableDecisionSubject;
  query: ListLeadingCitationsQuery;
};

/**
 * The treatment a row counts under, as SQL, grouping in the database the
 * way `treatmentOf` groups in code. The literal is a constant of this
 * module and is rendered inline rather than bound: the expression appears
 * twice in one statement and the planner must see the same text.
 */
const treatmentSql = sql<string>`CASE
  WHEN ${caseLawCitations.polarity} IS NULL
    OR ${caseLawCitations.polarity} = ${sql.raw(`'${POLARITY.UNKNOWN}'`)}
  THEN 'unclassified'
  ELSE ${caseLawCitations.polarity}
END`;

/**
 * The few decisions per treatment a reader should see first: the most
 * authoritative decisions citing this one (or cited by it), one row per
 * decision even where it cites the case several times. Ranked by the far
 * decision's materialized citation authority, which search ranks by too,
 * so the two surfaces agree on what "leading" means.
 */
export const listLeadingCitationsHandler = async ({
  subject: { id: decisionId, tx },
  query,
}: ListLeadingCitationsOptions): Promise<{ items: LeadingCitationRow[] }> => {
  const spec = DIRECTION_SPECS[query.direction];

  // One row per (treatment, far decision): its first citation in the text.
  const mentions = tx
    .select({
      id: caseLawCitations.id,
      citationText: caseLawCitations.citationText,
      sectionIndex: caseLawCitations.sectionIndex,
      polarity: caseLawCitations.polarity,
      treatment: treatmentSql.as("treatment"),
      relatedId: sql<string>`${spec.related}`.as("related_id"),
      authority: relatedDecision.citationAuthority,
      mentionRank: sql<number>`row_number() OVER (
        PARTITION BY ${treatmentSql}, ${spec.related}
        ORDER BY ${caseLawCitations.id}
      )`.as("mention_rank"),
    })
    .from(caseLawCitations)
    .innerJoin(relatedDecision, eq(relatedDecision.id, spec.related))
    .innerJoin(relatedSource, eq(relatedSource.id, relatedDecision.sourceId))
    .where(
      and(
        eq(spec.anchor, decisionId),
        precedentOnly,
        // Before ranking, so a hidden decision cannot take a leader's place.
        // Only a held decision can lead, whatever the direction keeps.
        visibleFor({
          farEnd: "decision",
          keepsUnresolved: false,
          related: spec.related,
        }),
      ),
    )
    .as("leading_mentions");

  const ranked = tx
    .select({
      id: mentions.id,
      citationText: mentions.citationText,
      sectionIndex: mentions.sectionIndex,
      polarity: mentions.polarity,
      relatedId: mentions.relatedId,
      rank: sql<number>`row_number() OVER (
        PARTITION BY ${mentions.treatment}
        ORDER BY ${mentions.authority} DESC, ${mentions.id}
      )`.as("authority_rank"),
    })
    .from(mentions)
    .where(eq(mentions.mentionRank, 1))
    .as("leading_ranked");

  const rows = await tx
    .select({
      id: ranked.id,
      citationText: ranked.citationText,
      sectionIndex: ranked.sectionIndex,
      polarity: ranked.polarity,
      decision: {
        id: relatedDecision.id,
        caseNumber: relatedDecision.caseNumber,
        caseNumberType: relatedDecision.caseNumberType,
        country: relatedDecision.country,
        court: relatedDecision.court,
        decisionDate: relatedDecision.decisionDate,
        decisionType: relatedDecision.decisionType,
        ecli: relatedDecision.ecli,
        language: relatedDecision.language,
        languageGroupKey: relatedDecision.languageGroupKey,
        slug: relatedDecision.slug,
        citationAuthority: relatedDecision.citationAuthority,
      },
    })
    .from(ranked)
    .innerJoin(
      relatedDecision,
      sql`${relatedDecision.id} = ${ranked.relatedId}::uuid`,
    )
    .where(sql`${ranked.rank} <= ${LEADING_CITATIONS_PER_TREATMENT}`)
    .orderBy(asc(ranked.rank), asc(ranked.id))
    .limit(CITATION_TREATMENTS.length * LEADING_CITATIONS_PER_TREATMENT);
  const toRelatedDecision = await withLanguageAlternates(
    tx,
    rows.map((row) => row.decision),
  );

  return {
    items: rows.map((row) => ({
      id: row.id,
      citationText: row.citationText,
      sectionIndex: row.sectionIndex,
      treatment: treatmentOf(row.polarity),
      decision: toRelatedDecision(row.decision),
    })),
  };
};
