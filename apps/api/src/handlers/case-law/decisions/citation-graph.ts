import { and, asc, eq, gt, sql } from "drizzle-orm";
import type { SQL, SQLWrapper } from "drizzle-orm";
import { alias, unionAll } from "drizzle-orm/pg-core";
import { status, t } from "elysia";
import type { Static } from "elysia";

import { CASE_LAW_CITATION_TIMELINE_MAX_YEARS } from "@stll/api-contract";

import {
  caseLawCitations,
  caseLawDecisions,
  caseLawSources,
} from "@/api/db/schema";
import { CITATION_KIND } from "@/api/handlers/case-law/citation-kind";
import type { RedistributableDecisionSubject } from "@/api/handlers/case-law/decisions/public-subject";
import { POLARITIES, POLARITY } from "@/api/handlers/case-law/polarity/consts";
import type { SafeId } from "@/api/lib/branded-types";
import { redistributableCaseLawSourceFor } from "@/api/lib/case-law/redistribution";
import { tPaginationCursor } from "@/api/lib/custom-schema";
import { LIMITS } from "@/api/lib/limits";
import {
  decodePaginationCursor,
  encodePaginationCursor,
  isUuidPaginationCursorPart,
  type Page,
} from "@/api/lib/pagination";
import { brandPersistedCaseLawCitationId } from "@/api/lib/safe-id-boundaries";
import { includes } from "@/api/lib/type-guards";

/**
 * One side of the citation graph, seen from a decision: the decisions it
 * relies on (`outgoing`) or the decisions that rely on it (`incoming`).
 */
export const CITATION_DIRECTIONS = ["incoming", "outgoing"] as const;
export type CitationDirection = (typeof CITATION_DIRECTIONS)[number];

export const listDecisionCitationsQuerySchema = t.Object({
  direction: t.Union(CITATION_DIRECTIONS.map((value) => t.Literal(value))),
  cursor: t.Optional(tPaginationCursor()),
});

type ListDecisionCitationsQuery = Static<
  typeof listDecisionCitationsQuerySchema
>;

/**
 * How the citing text treats the cited decision, as the display reads it.
 *
 * `unclassified` folds a row the classifier never reached (`null`) together
 * with one it reached and could not answer (`unknown`): neither is a reading
 * of the text, so neither may pose as one. The classifiable polarities pass
 * through by name.
 */
export const CITATION_TREATMENTS = [
  POLARITY.NEGATIVE,
  POLARITY.NEUTRAL,
  POLARITY.POSITIVE,
  POLARITY.SUPPORTIVE,
  "unclassified",
] as const;
export type CitationTreatment = (typeof CITATION_TREATMENTS)[number];

export const treatmentOf = (polarity: string | null): CitationTreatment => {
  if (polarity === null || !includes(POLARITIES, polarity)) {
    return "unclassified";
  }
  return polarity === POLARITY.UNKNOWN ? "unclassified" : polarity;
};

/** The decision at the far end of a citation, enough to address its page. */
type RelatedDecision = {
  id: SafeId<"caseLawDecision">;
  caseNumber: string;
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
  slug: string | null;
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
  decision: RelatedDecision | null;
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
  decision: RelatedDecision | null;
};

/**
 * The page keeps the scan's own boundary: the cursor advances over every
 * examined row, visible or not, so a run of hidden rows can never stall it,
 * and a page may legitimately hold fewer than `limit` items.
 */
const createScannedPage = (
  rows: readonly ScannedRow[],
): Page<DecisionCitationRow> => {
  const limit = LIMITS.caseLawDecisionCitationPageSize;
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
      decision: row.decision,
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
 * A row the reader may see: its far end is a decision from a source that
 * allows redistribution, or (outgoing only) there is no far end to protect.
 */
const visibleFor = ({
  keepsUnresolved,
  related,
}: {
  keepsUnresolved: boolean;
  /** The far-end id as the enclosing query can see it. */
  related: SQLWrapper;
}): SQL<boolean> => {
  const resolvedAndOpen = sql`(
    ${relatedSource.id} IS NOT NULL
    AND ${redistributableCaseLawSourceFor(relatedSource.descriptor)}
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
};

export const listDecisionCitationsHandler = async ({
  subject: { id: decisionId, tx },
  query,
}: ListDecisionCitationsOptions) => {
  const cursorId = decodeCitationCursor(query.cursor);
  if (cursorId === null) {
    return status(400, { message: "Invalid cursor" });
  }
  const spec = DIRECTION_SPECS[query.direction];

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
        eq(spec.anchor, decisionId),
        precedentOnly,
        cursorId === undefined ? undefined : gt(caseLawCitations.id, cursorId),
      ),
    )
    .orderBy(asc(caseLawCitations.id))
    .limit(LIMITS.caseLawDecisionCitationPageSize + 1)
    .as("citation_graph_candidates");
  const rows = await tx
    .select({
      id: candidates.id,
      citationText: candidates.citationText,
      sectionIndex: candidates.sectionIndex,
      polarity: candidates.polarity,
      visible: visibleFor({
        keepsUnresolved: spec.keepsUnresolved,
        related: candidates.relatedId,
      }),
      decision: {
        id: relatedDecision.id,
        caseNumber: relatedDecision.caseNumber,
        country: relatedDecision.country,
        court: relatedDecision.court,
        decisionDate: relatedDecision.decisionDate,
        decisionType: relatedDecision.decisionType,
        ecli: relatedDecision.ecli,
        language: relatedDecision.language,
        slug: relatedDecision.slug,
      },
    })
    .from(candidates)
    .leftJoin(relatedDecision, eq(relatedDecision.id, candidates.relatedId))
    .leftJoin(relatedSource, eq(relatedSource.id, relatedDecision.sourceId))
    .orderBy(asc(candidates.id))
    .limit(LIMITS.caseLawDecisionCitationPageSize + 1);

  return createScannedPage(rows);
};

export type CitationTreatmentCounts = Record<CitationTreatment, number>;

export type CitationYearCounts = CitationTreatmentCounts & { year: number };

export type DecisionCitationSummary = Record<
  CitationDirection,
  CitationTreatmentCounts
> & {
  /**
   * Incoming citations by the citing decision's year, oldest first; a year
   * with no citations is absent. Spans at most `CITATION_TIMELINE_MAX_YEARS`
   * ending this year, so the payload stays bounded however old the decision.
   */
  incomingByYear: CitationYearCounts[];
};

/** How far back the per-year rollup reaches, counted to the current year. */
export const CITATION_TIMELINE_MAX_YEARS = CASE_LAW_CITATION_TIMELINE_MAX_YEARS;

const emptyTreatmentCounts = (): CitationTreatmentCounts => ({
  negative: 0,
  neutral: 0,
  positive: 0,
  supportive: 0,
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
};

/**
 * How many precedent citations each direction holds, by treatment, and the
 * incoming ones by year.
 *
 * Counts only what the list would show, so the rollup and the rows agree:
 * a citation whose far end may not be redistributed is absent from both.
 * One statement serves all three figures: each side of the graph is one
 * indexed aggregate, and the incoming side is walked once for both its
 * totals and its years; never a walk over pages.
 */
export const summarizeDecisionCitationsHandler = async ({
  subject: { id: decisionId, tx },
  currentYear = new Date().getUTCFullYear(),
}: SummarizeDecisionCitationsOptions) => {
  const scopeFor = (direction: CitationDirection) => {
    const spec = DIRECTION_SPECS[direction];
    return and(
      eq(spec.anchor, decisionId),
      precedentOnly,
      visibleFor({
        keepsUnresolved: spec.keepsUnresolved,
        related: spec.related,
      }),
    );
  };

  const firstYear = currentYear - (CITATION_TIMELINE_MAX_YEARS - 1);
  const citingYearInSpan = sql<number | null>`CASE
    WHEN ${relatedDecision.decisionDate} >= make_date(${firstYear}::int, 1, 1)
     AND ${relatedDecision.decisionDate} < make_date(${currentYear + 1}::int, 1, 1)
    THEN extract(year from ${relatedDecision.decisionDate})::int
  END`;
  const count = sql<number>`count(*)::int`;

  const incoming = tx
    .select({
      direction: sql<CitationDirection>`'incoming'`.as("direction"),
      year: citingYearInSpan.as("year"),
      polarity: caseLawCitations.polarity,
      count: count.as("count"),
    })
    .from(caseLawCitations)
    .innerJoin(
      relatedDecision,
      eq(relatedDecision.id, DIRECTION_SPECS.incoming.related),
    )
    .leftJoin(relatedSource, eq(relatedSource.id, relatedDecision.sourceId))
    .where(scopeFor("incoming"))
    // By ordinal: the year expression binds its bounds as parameters, and
    // a second rendering would bind fresh ones the planner cannot match.
    .groupBy(sql`2`, caseLawCitations.polarity);

  const outgoing = tx
    .select({
      direction: sql<CitationDirection>`'outgoing'`.as("direction"),
      year: sql<number | null>`NULL::int`.as("year"),
      polarity: caseLawCitations.polarity,
      count: count.as("count"),
    })
    .from(caseLawCitations)
    .leftJoin(
      relatedDecision,
      eq(relatedDecision.id, DIRECTION_SPECS.outgoing.related),
    )
    .leftJoin(relatedSource, eq(relatedSource.id, relatedDecision.sourceId))
    .where(scopeFor("outgoing"))
    .groupBy(caseLawCitations.polarity);

  // One row per (direction, year-or-null, stored polarity): the span and
  // the polarity check constraint already cap it, this states the cap.
  const rows = await unionAll(incoming, outgoing).limit(
    (CITATION_TIMELINE_MAX_YEARS + 2) * (POLARITIES.length + 1),
  );

  const totals: Record<CitationDirection, CitationTreatmentCounts> = {
    incoming: emptyTreatmentCounts(),
    outgoing: emptyTreatmentCounts(),
  };
  const byYear = new Map<number, CitationYearCounts>();
  for (const row of rows satisfies readonly SummaryRow[]) {
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

  return {
    incoming: totals.incoming,
    outgoing: totals.outgoing,
    incomingByYear: [...byYear.values()].sort((a, b) => a.year - b.year),
  };
};

/** How many decisions each treatment shows before the reader asks for all. */
export const LEADING_CITATIONS_PER_TREATMENT = 3;

export const listLeadingCitationsQuerySchema = t.Object({
  direction: t.Union(CITATION_DIRECTIONS.map((value) => t.Literal(value))),
});

type ListLeadingCitationsQuery = Static<typeof listLeadingCitationsQuerySchema>;

export type LeadingCitationRow = {
  id: SafeId<"caseLawCitation">;
  citationText: string;
  sectionIndex: number | null;
  treatment: CitationTreatment;
  /** Resolved by construction: only a held decision can lead. */
  decision: RelatedDecision & { citationAuthority: number };
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
        redistributableCaseLawSourceFor(relatedSource.descriptor),
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
        country: relatedDecision.country,
        court: relatedDecision.court,
        decisionDate: relatedDecision.decisionDate,
        decisionType: relatedDecision.decisionType,
        ecli: relatedDecision.ecli,
        language: relatedDecision.language,
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

  return {
    items: rows.map((row) => ({
      id: row.id,
      citationText: row.citationText,
      sectionIndex: row.sectionIndex,
      treatment: treatmentOf(row.polarity),
      decision: row.decision,
    })),
  };
};
