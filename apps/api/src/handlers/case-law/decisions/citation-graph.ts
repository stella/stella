import { and, asc, eq, gt, sql } from "drizzle-orm";
import type { SQL, SQLWrapper } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { status, t } from "elysia";
import type { Static } from "elysia";

import {
  caseLawCitations,
  caseLawDecisions,
  caseLawSources,
} from "@/api/db/schema";
import { CITATION_KIND } from "@/api/handlers/case-law/citation-kind";
import { POLARITIES, POLARITY } from "@/api/handlers/case-law/polarity/consts";
import type { SafeId } from "@/api/lib/branded-types";
import type { CaseLawPublicReadDb } from "@/api/lib/case-law-public-read-db";
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
  caseLawDb: CaseLawPublicReadDb;
  decisionId: SafeId<"caseLawDecision">;
  query: ListDecisionCitationsQuery;
};

export const listDecisionCitationsHandler = async ({
  caseLawDb,
  decisionId,
  query,
}: ListDecisionCitationsOptions) => {
  const cursorId = decodeCitationCursor(query.cursor);
  if (cursorId === null) {
    return status(400, { message: "Invalid cursor" });
  }
  const spec = DIRECTION_SPECS[query.direction];

  const rows = await caseLawDb((tx) => {
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
          cursorId === undefined
            ? undefined
            : gt(caseLawCitations.id, cursorId),
        ),
      )
      .orderBy(asc(caseLawCitations.id))
      .limit(LIMITS.caseLawDecisionCitationPageSize + 1)
      .as("citation_graph_candidates");

    return tx
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
          language: relatedDecision.language,
          slug: relatedDecision.slug,
        },
      })
      .from(candidates)
      .leftJoin(relatedDecision, eq(relatedDecision.id, candidates.relatedId))
      .leftJoin(relatedSource, eq(relatedSource.id, relatedDecision.sourceId))
      .orderBy(asc(candidates.id))
      .limit(LIMITS.caseLawDecisionCitationPageSize + 1);
  });

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
export const CITATION_TIMELINE_MAX_YEARS = 60;

const emptyTreatmentCounts = (): CitationTreatmentCounts => ({
  negative: 0,
  neutral: 0,
  positive: 0,
  supportive: 0,
  unclassified: 0,
});

type SummarizeDecisionCitationsOptions = {
  caseLawDb: CaseLawPublicReadDb;
  decisionId: SafeId<"caseLawDecision">;
  /** The year the timeline ends; injectable so a test can pin it. */
  currentYear?: number;
};

type PolarityCountRow = { polarity: string | null; count: number };

const foldTreatments = (
  rows: readonly PolarityCountRow[],
): CitationTreatmentCounts => {
  const counts = emptyTreatmentCounts();
  for (const row of rows) {
    counts[treatmentOf(row.polarity)] += row.count;
  }
  return counts;
};

/**
 * How many precedent citations each direction holds, by treatment, and the
 * incoming ones by year.
 *
 * Counts only what the list would show, so the rollup and the rows agree:
 * a citation whose far end may not be redistributed is absent from both.
 * Each figure is one indexed aggregate; never a walk over pages.
 */
export const summarizeDecisionCitationsHandler = async ({
  caseLawDb,
  decisionId,
  currentYear = new Date().getUTCFullYear(),
}: SummarizeDecisionCitationsOptions): Promise<DecisionCitationSummary> => {
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

  const countFor = async (direction: CitationDirection) =>
    await caseLawDb((tx) =>
      tx
        .select({
          polarity: caseLawCitations.polarity,
          count: sql<number>`count(*)::int`,
        })
        .from(caseLawCitations)
        .leftJoin(
          relatedDecision,
          eq(relatedDecision.id, DIRECTION_SPECS[direction].related),
        )
        .leftJoin(relatedSource, eq(relatedSource.id, relatedDecision.sourceId))
        .where(scopeFor(direction))
        .groupBy(caseLawCitations.polarity),
    );

  const firstYear = currentYear - (CITATION_TIMELINE_MAX_YEARS - 1);
  const citingYear = sql<number>`extract(year from ${relatedDecision.decisionDate})::int`;
  const countIncomingByYear = async () =>
    await caseLawDb((tx) =>
      tx
        .select({
          year: citingYear,
          polarity: caseLawCitations.polarity,
          count: sql<number>`count(*)::int`,
        })
        .from(caseLawCitations)
        .innerJoin(
          relatedDecision,
          eq(relatedDecision.id, DIRECTION_SPECS.incoming.related),
        )
        .leftJoin(relatedSource, eq(relatedSource.id, relatedDecision.sourceId))
        .where(
          and(
            scopeFor("incoming"),
            sql`${relatedDecision.decisionDate} >= make_date(${firstYear}::int, 1, 1)`,
            sql`${relatedDecision.decisionDate} < make_date(${currentYear + 1}::int, 1, 1)`,
          ),
        )
        .groupBy(citingYear, caseLawCitations.polarity)
        .orderBy(asc(citingYear))
        // One row per (year, stored polarity) inside the span: the date
        // bounds above already cap it, this states the cap.
        .limit(CITATION_TIMELINE_MAX_YEARS * (POLARITIES.length + 1)),
    );

  const [incomingRows, outgoingRows, yearRows] = await Promise.all([
    countFor("incoming"),
    countFor("outgoing"),
    countIncomingByYear(),
  ]);

  const byYear = new Map<number, CitationYearCounts>();
  for (const row of yearRows) {
    const counts = byYear.get(row.year) ?? {
      ...emptyTreatmentCounts(),
      year: row.year,
    };
    counts[treatmentOf(row.polarity)] += row.count;
    byYear.set(row.year, counts);
  }

  return {
    incoming: foldTreatments(incomingRows),
    outgoing: foldTreatments(outgoingRows),
    incomingByYear: [...byYear.values()],
  };
};
