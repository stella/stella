import { panic } from "better-result";
import { and, asc, desc, eq, gt, inArray, lte, sql } from "drizzle-orm";
import type { SQL, SQLWrapper } from "drizzle-orm";
import { alias, unionAll } from "drizzle-orm/pg-core";
import * as v from "valibot";

import {
  CASE_LAW_CITATION_SUMMARY_SCAN_LIMIT as CITATION_SUMMARY_SCAN_LIMIT,
  CASE_LAW_CITATION_TIMELINE_MAX_YEARS,
} from "@stll/api-contract";
import type { DecisionPrimaryReferenceType } from "@stll/legal-ast/decision-identifier";
import { Temporal } from "@stll/time";

import {
  caseLawCitationDoctrineReviews,
  caseLawCitations,
  caseLawDecisionCitationStats,
  caseLawDecisionCitationStatsState,
  caseLawSources,
  publishedCaseLawDecisions,
} from "@/api/db/schema";
import { CITATION_KIND } from "@/api/handlers/case-law/citation-kind";
import { POLARITIES, POLARITY } from "@/api/handlers/case-law/polarity/consts";
import { status } from "@/api/http/status";
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
import { decisionCourtAbbreviation } from "@/api/lib/case-law/court-presentation";
import {
  canonicalRuleApplies,
  DECISION_WORK_MANIFESTATIONS_MAX,
  decisionWorkOf,
  isSingleManifestationWork,
  workCitationStream,
} from "@/api/lib/case-law/decision-work";
import type { DecisionWork } from "@/api/lib/case-law/decision-work";
import { DOCTRINAL_TREATMENTS } from "@/api/lib/case-law/doctrine";
import type { DoctrineTreatment } from "@/api/lib/case-law/doctrine";
import { readPublicDecisionLanguageAlternatesInTx } from "@/api/lib/case-law/language-alternates";
import type { PublicDecisionLanguageAlternate } from "@/api/lib/case-law/language-alternates";
import type { RedistributableDecisionSubject } from "@/api/lib/case-law/public-subject";
import { redistributableCaseLawSourceFor } from "@/api/lib/case-law/redistribution";
import { paginationCursorSchema } from "@/api/lib/custom-schema";
import { boundedAll } from "@/api/lib/db/bounded-all";
import { LIMITS } from "@/api/lib/limits";
import { logger } from "@/api/lib/observability/logger";
import {
  decodePaginationCursor,
  encodePaginationCursor,
  isUuidPaginationCursorPart,
  type Page,
} from "@/api/lib/pagination";
import {
  DOCTRINE_COLUMN_GRANTS_BY_RELATION,
  PUBLIC_LAW_COLUMN_GRANTS_BY_RELATION,
} from "@/api/lib/public-law-relations";
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

/** Expand release permits these columns; a following release grants them. */
const canReadCitationDoctrine = async (tx: CaseLawPublicReadTransaction) => {
  const predicates = Object.entries(DOCTRINE_COLUMN_GRANTS_BY_RELATION).flatMap(
    ([relation, columns]) =>
      Object.keys(columns).map(
        (column) =>
          sql`has_column_privilege(current_user, ${`public.${relation}`}, ${column}, 'SELECT')`,
      ),
  );
  const rows = await tx
    .select({ available: sql<boolean>`${sql.join(predicates, sql` AND `)}` })
    .from(sql`(SELECT 1) AS citation_doctrine_permission_probe`);
  return (
    rows.at(0) ?? panic("Citation doctrine permission probe returned no result")
  ).available;
};

const doctrineOf = (
  doctrineAvailable: boolean,
  doctrine: DoctrineTreatment | null,
): DoctrineTreatment | "unread" | null =>
  doctrineAvailable ? (doctrine ?? "unread") : null;

/**
 * The stored doctrine when the reader may see it. Both branches share one
 * SQL type so the subqueries built over it keep their field types.
 */
/** A read that shows no quotes still selects the column, as NULL. */
const NO_EVIDENCE_QUOTE = sql<string | null>`NULL::text`.as("evidence_quote");

const doctrinalTreatmentField = (available: boolean) =>
  (available
    ? sql<DoctrineTreatment | null>`${caseLawCitations.doctrinalTreatment}`
    : sql<DoctrineTreatment | null>`NULL::varchar`
  ).as("doctrinal_treatment");

/**
 * The quote behind the citation's current doctrine. A correlated read rather
 * than a join, so a reader without the review grants never names the table;
 * the unique (citing decision, citation key) index makes it a point lookup.
 */
const doctrineEvidenceQuoteField = (available: boolean) =>
  (available
    ? sql<string | null>`(SELECT ${caseLawCitationDoctrineReviews.evidenceQuote}
        FROM ${caseLawCitationDoctrineReviews}
        WHERE ${caseLawCitationDoctrineReviews.citingDecisionId} = ${caseLawCitations.citingDecisionId}
          AND ${caseLawCitationDoctrineReviews.citationKey} = ${caseLawCitations.citationKey}
          AND ${caseLawCitationDoctrineReviews.doctrinalTreatment} = ${caseLawCitations.doctrinalTreatment})`
    : sql<string | null>`NULL::text`
  ).as("evidence_quote");

const [distinguishesDoctrine, limitsDoctrine] = DOCTRINAL_TREATMENTS;
const [
  negativePolarity,
  neutralPolarity,
  positivePolarity,
  supportivePolarity,
  mixedPolarity,
  unclassifiedPolarity,
] = CITATION_TREATMENTS;

const listDecisionCitationsQueryEntries = v.object({
  direction: v.picklist(CITATION_DIRECTIONS),
  doctrine: v.optional(
    v.union([v.literal(distinguishesDoctrine), v.literal(limitsDoctrine)]),
  ),
  polarity: v.optional(
    v.union([
      v.literal(negativePolarity),
      v.literal(neutralPolarity),
      v.literal(positivePolarity),
      v.literal(supportivePolarity),
      v.literal(mixedPolarity),
      v.literal(unclassifiedPolarity),
    ]),
  ),
  cursor: v.optional(paginationCursorSchema()),
});

type ListDecisionCitationsQuery = v.InferOutput<
  typeof listDecisionCitationsQueryEntries
>;

/** A cursor belongs to one direction and filter; any other is refused as input. */
export const listDecisionCitationsQuerySchema = v.pipe(
  listDecisionCitationsQueryEntries,
  v.forward(
    v.check(
      (query) => decodeCitationCursor(query.cursor, query) !== null,
      "Invalid cursor",
    ),
    ["cursor"],
  ),
);

/** The decision at the far end of a citation, enough to address its page. */
type RelatedDecision = {
  id: SafeId<"caseLawDecision">;
  caseNumber: string;
  /** What kind of reference `caseNumber` is. */
  caseNumberType: DecisionPrimaryReferenceType;
  country: string;
  court: string;
  courtAbbreviation: string | null;
  sourceUrl: string | null;
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
  "languageAlternates" | "courtAbbreviation"
> & { languageGroupKey: string | null; courtId: string | null };

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
  return ({ languageGroupKey, courtId, ...decision }) =>
    Object.assign(decision, {
      courtAbbreviation: decisionCourtAbbreviation({ ...decision, courtId }),
      languageAlternates: alternates.alternatesFor(languageGroupKey),
    });
};

export type DecisionCitationRow = {
  id: SafeId<"caseLawCitation">;
  /**
   * The language version whose text prints the citation: the subject's work
   * lists each citation once, as the version that holds its canonical rows,
   * so an outgoing row may come from another version than the one read. Not
   * part of any response; a passage is looked up in this version's text.
   */
  printedBy: SafeId<"caseLawDecision">;
  citationText: string;
  sectionIndex: number | null;
  treatment: CitationTreatment;
  doctrine: DoctrineTreatment | "unread" | null;
  evidenceQuote: string | null;
  /**
   * Null only for an outgoing citation the corpus could not resolve to a
   * held decision; such a row is text and nothing more. An incoming citation
   * is by construction resolved, so its decision is always present.
   */
  decision: RankedRelatedDecision | null;
};

/** Each capped citation probes one published decision through the view boundary. */
const relatedDecisionLookup = (
  tx: CaseLawPublicReadTransaction,
  relatedId: SQLWrapper,
) =>
  tx
    .select({
      id: publishedCaseLawDecisions.id,
      sourceId: publishedCaseLawDecisions.sourceId,
      caseNumber: publishedCaseLawDecisions.caseNumber,
      caseNumberType: publishedCaseLawDecisions.caseNumberType,
      country: publishedCaseLawDecisions.country,
      court: publishedCaseLawDecisions.court,
      courtId: publishedCaseLawDecisions.courtId,
      sourceUrl: publishedCaseLawDecisions.sourceUrl,
      decisionDate: publishedCaseLawDecisions.decisionDate,
      decisionType: publishedCaseLawDecisions.decisionType,
      ecli: publishedCaseLawDecisions.ecli,
      language: publishedCaseLawDecisions.language,
      languageGroupKey: publishedCaseLawDecisions.languageGroupKey,
      slug: publishedCaseLawDecisions.slug,
      citationAuthority: publishedCaseLawDecisions.citationAuthority,
    })
    .from(publishedCaseLawDecisions)
    .where(eq(publishedCaseLawDecisions.id, relatedId))
    .limit(1)
    .as("graph_related_decision");
const relatedSource = alias(caseLawSources, "graph_related_source");

export const decodeCitationCursor = (
  cursor: string | undefined,
  query: Omit<ListDecisionCitationsQuery, "cursor">,
): SafeId<"caseLawCitation"> | null | undefined => {
  if (cursor === undefined) {
    return undefined;
  }

  const parts = decodePaginationCursor(cursor);
  const id = parts?.at(0);
  if (
    parts?.length !== 4 ||
    !isUuidPaginationCursorPart(id) ||
    parts.at(1) !== query.direction ||
    parts.at(2) !== (query.doctrine ?? null) ||
    parts.at(3) !== (query.polarity ?? null)
  ) {
    return null;
  }

  return brandPersistedCaseLawCitationId(id);
};

export const encodeCitationCursor = (id: SafeId<"caseLawCitation">): string =>
  encodePaginationCursor([id]);

/** The citation page cursor `decodeCitationCursor` accepts: bound to its filter. */
export const encodeCitationPageCursor = ({
  id,
  query,
}: {
  id: SafeId<"caseLawCitation">;
  query: Omit<ListDecisionCitationsQuery, "cursor">;
}): string =>
  encodePaginationCursor([
    id,
    query.direction,
    query.doctrine ?? null,
    query.polarity ?? null,
  ]);

type ScannedRow = {
  id: SafeId<"caseLawCitation">;
  citationText: string;
  sectionIndex: number | null;
  polarity: string | null;
  doctrinalTreatment: DoctrineTreatment | null;
  evidenceQuote: string | null;
  printedBy: SafeId<"caseLawDecision">;
  visible: boolean;
  /** Not a duplicate of another language version's row. */
  canonical: boolean;
  /** 1-based position in the page's raw window. */
  ordinal: number;
  decision: RankedRelatedDecisionRow | null;
};

type CreateScannedPageOptions = {
  doctrineAvailable: boolean;
  rows: readonly ScannedRow[];
  limit: number;
  /** Raw rows the query's window examined at most. */
  windowSize: number;
  toRelatedDecision: (row: RankedRelatedDecisionRow) => RankedRelatedDecision;
  query: Omit<ListDecisionCitationsQuery, "cursor">;
};

/**
 * The page keeps the scan's own boundary: the cursor advances over every
 * examined row, visible or not, so a run of hidden rows can never stall it,
 * and a page may legitimately hold fewer than `limit` items.
 *
 * Duplicates of another version's rows are skipped inside a raw window of
 * `windowSize` rows; when the window fills before the page does, the page
 * ends at the window's last row (`ordinal === windowSize`), which the query
 * returns whether or not it is canonical, so the next page resumes after it.
 */
const createScannedPage = ({
  doctrineAvailable,
  rows,
  limit,
  windowSize,
  toRelatedDecision,
  query,
}: CreateScannedPageOptions): Page<DecisionCitationRow> => {
  const canonical = rows.filter((row) => row.canonical);
  const scanned = canonical.slice(0, limit);
  const items: DecisionCitationRow[] = [];
  for (const row of scanned) {
    if (!row.visible) {
      continue;
    }
    items.push({
      id: row.id,
      printedBy: row.printedBy,
      citationText: row.citationText,
      sectionIndex: row.sectionIndex,
      treatment: treatmentOf(row.polarity),
      doctrine: doctrineOf(doctrineAvailable, row.doctrinalTreatment),
      evidenceQuote: row.evidenceQuote,
      decision: row.decision === null ? null : toRelatedDecision(row.decision),
    });
  }
  const lastScanned = scanned.at(-1);
  const windowEnd = rows.find((row) => row.ordinal === windowSize);
  let boundary: SafeId<"caseLawCitation"> | null = null;
  if (canonical.length > limit && lastScanned !== undefined) {
    boundary = lastScanned.id;
  } else if (windowEnd !== undefined) {
    boundary = windowEnd.id;
  }

  return {
    items,
    limit,
    nextCursor:
      boundary === null
        ? null
        : encodeCitationPageCursor({ id: boundary, query }),
  };
};

/**
 * Which end of a row a read anchors on, and which it shows as `relatedId`,
 * belongs to `decision-work.ts`: every read here anchors on the subject's
 * work, never on the subject row alone.
 */
type DirectionSpec = {
  /** Whether an unresolved row (no far end) still belongs to the reader. */
  keepsUnresolved: boolean;
};

const DIRECTION_SPECS = {
  incoming: { keepsUnresolved: false },
  outgoing: { keepsUnresolved: true },
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
  country,
  countries,
}: {
  keepsUnresolved: boolean;
  /**
   * The far end's country. Its row comes from the published-decision view or
   * from the citation projection, which holds only published far ends, so
   * publication needs no second check here.
   */
  country: SQLWrapper;
  /** The subject's own country list; the far end answers to the same list. */
  countries: readonly string[];
  /** The far-end id as the enclosing query can see it. */
  related: SQLWrapper;
}): SQL<boolean> => {
  const resolvedAndOpen = sql`(
    ${relatedSource.id} IS NOT NULL
    AND ${redistributableCaseLawSourceFor(relatedSource.descriptor)}
    AND ${inArray(country, [...countries])}
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
  subject,
  query,
  limit = LIMITS.caseLawDecisionCitationPageSize,
}: ListDecisionCitationsOptions) => {
  const { countries, tx } = subject;
  const { cursor: _cursor, ...cursorQuery } = query;
  const cursorId = decodeCitationCursor(query.cursor, cursorQuery);
  if (cursorId === null) {
    return status(400, { message: "Invalid cursor" });
  }
  const pageSize = normalizeTenantPageLimit(
    Math.min(limit, LIMITS.caseLawDecisionCitationPageSize),
  );
  const doctrineAvailable = await canReadCitationDoctrine(tx);
  if (query.doctrine !== undefined && !doctrineAvailable) {
    return status(422, { message: "Doctrine filtering is unavailable" });
  }
  const work = await decisionWorkOf(subject);
  const rows = await decisionCitationPageQuery({
    doctrineAvailable,
    cursorId,
    work,
    direction: query.direction,
    ...(query.doctrine === undefined ? {} : { doctrine: query.doctrine }),
    ...(query.polarity === undefined ? {} : { polarity: query.polarity }),
    limit: pageSize,
    countries,
    tx,
  });
  const toRelatedDecision = await withLanguageAlternates(
    tx,
    rows.map((row) => (row.visible && row.canonical ? row.decision : null)),
  );

  return {
    ...createScannedPage({
      doctrineAvailable,
      rows,
      limit: pageSize,
      windowSize: citationPageWindowSize({
        direction: query.direction,
        limit: pageSize,
        work,
      }),
      toRelatedDecision,
      query: cursorQuery,
    }),
    doctrineAvailability: doctrineAvailable
      ? ("available" as const)
      : ("unavailable" as const),
  };
};

type DecisionCitationPageQueryOptions = {
  /** Whether this reader holds the doctrine grants. */
  doctrineAvailable: boolean;
  cursorId: SafeId<"caseLawCitation"> | undefined;
  /** The subject's work: the page lists the citations of every version. */
  work: DecisionWork;
  direction: CitationDirection;
  doctrine?: Exclude<DoctrineTreatment, "not_stated">;
  polarity?: CitationTreatment;
  limit: number;
  countries: readonly string[];
  tx: CaseLawPublicReadTransaction;
};

/**
 * Raw rows one page examines at most. A row the canonical rule drops belongs
 * to a citing judgment with at most the work ceiling of versions, so this
 * window holds a full page unless the rows of other versions crowd it, and a
 * page that must skip more ends at the window instead of reading on.
 */
export const citationPageWindowSize = ({
  direction,
  limit,
  work,
}: {
  direction: CitationDirection;
  limit: number;
  work: DecisionWork;
}): number =>
  canonicalRuleApplies(direction, work)
    ? (limit + 1) * DECISION_WORK_MANIFESTATIONS_MAX
    : limit + 1;

export const decisionCitationPageQuery = ({
  doctrineAvailable,
  cursorId,
  work,
  direction,
  doctrine,
  polarity,
  limit,
  countries,
  tx,
}: DecisionCitationPageQueryOptions) => {
  const spec = DIRECTION_SPECS[direction];
  let doctrineFilter: SQL | undefined;
  if (doctrine !== undefined) {
    doctrineFilter = doctrineAvailable
      ? eq(caseLawCitations.doctrinalTreatment, doctrine)
      : sql`false`;
  }
  let polarityFilter: SQL | undefined;
  if (polarity === "unclassified") {
    polarityFilter = sql`(${caseLawCitations.polarity} IS NULL OR ${caseLawCitations.polarity} = ${POLARITY.UNKNOWN})`;
  } else if (polarity !== undefined) {
    polarityFilter = eq(caseLawCitations.polarity, polarity);
  }

  const windowSize = citationPageWindowSize({ direction, limit, work });
  const window = workCitationStream({
    tx,
    work,
    direction,
    fields: {
      doctrinalTreatment: doctrinalTreatmentField(doctrineAvailable),
      evidenceQuote: doctrineEvidenceQuoteField(doctrineAvailable),
    },
    where: and(precedentOnly, doctrineFilter, polarityFilter),
    after: cursorId,
    limit: windowSize,
  });
  const candidates = tx
    .select({
      id: window.id,
      citationText: window.citationText,
      relatedId: window.relatedId,
      sectionIndex: window.sectionIndex,
      polarity: window.polarity,
      doctrinalTreatment: window.doctrinalTreatment,
      evidenceQuote: window.evidenceQuote,
      printedBy: window.citingDecisionId,
      ordinal: window.ordinal,
      canonical: window.canonical,
    })
    .from(window)
    .where(sql`(${window.ordinal} = ${windowSize} OR ${window.canonical})`)
    .orderBy(asc(window.id))
    .limit(limit + 1)
    .as("citation_graph_candidates");
  const relatedDecision = relatedDecisionLookup(tx, candidates.relatedId);
  return tx
    .select({
      id: candidates.id,
      citationText: candidates.citationText,
      sectionIndex: candidates.sectionIndex,
      polarity: candidates.polarity,
      doctrinalTreatment: candidates.doctrinalTreatment,
      evidenceQuote: candidates.evidenceQuote,
      printedBy: candidates.printedBy,
      ordinal: candidates.ordinal,
      canonical: candidates.canonical,
      visible: visibleFor({
        countries,
        keepsUnresolved: spec.keepsUnresolved,
        related: candidates.relatedId,
        country: relatedDecision.country,
      }),
      decision: {
        id: relatedDecision.id,
        caseNumber: relatedDecision.caseNumber,
        caseNumberType: relatedDecision.caseNumberType,
        country: relatedDecision.country,
        court: relatedDecision.court,
        courtId: relatedDecision.courtId,
        sourceUrl: relatedDecision.sourceUrl,
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
    .leftJoinLateral(relatedDecision, sql`true`)
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
  countries: readonly string[];
  tx: CaseLawPublicReadTransaction;
  doctrineAvailable?: boolean;
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
  countries,
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
          countries,
          keepsUnresolved: true,
          related: stats.relatedSourceId,
          country: stats.relatedCountry,
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
 * a citation whose far end may not be redistributed is absent from both, and
 * so is a language version's copy of a citation another version holds.
 * Exact projections serve totals and the timeline after per-decision backfill,
 * for a decision that is its work's only version: the projection counts one
 * row's edges and cannot tell several versions' copies of one citation apart.
 * Every other read keeps the bounded edge scan over the work and advertises
 * lower bounds.
 */
export const summarizeDecisionCitationsHandler = async ({
  subject,
  currentYear = Temporal.Now.plainDateISO("UTC").year,
}: SummarizeDecisionCitationsOptions) => {
  const { id: decisionId, countries, tx } = subject;
  const work = await decisionWorkOf(subject);
  const projectable = isSingleManifestationWork(work);
  const canReadStats = projectable && (await canReadDecisionCitationStats(tx));
  if (projectable && !canReadStats) {
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
            countries,
            tx,
            limit,
          }),
      })
    : await decisionCitationSummaryQuery({
        currentYear,
        work,
        countries,
        tx,
      }).summary;

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

type DecisionCitationScanOptions = {
  currentYear: number;
  /** The subject's work: the scan reads the edges of every version. */
  work: DecisionWork;
  countries: readonly string[];
  tx: CaseLawPublicReadTransaction;
  doctrineAvailable?: boolean;
};

/**
 * The bounded summary and top-citer ranking share the raw incoming window.
 * Ranking precision is independent of the summary's projection precision:
 * non-precedent and hidden edges, and other versions' copies of a citation,
 * still occupy places in this window.
 */
export const decisionCitationSummaryQuery = ({
  doctrineAvailable = false,
  currentYear,
  work,
  countries,
  tx,
}: DecisionCitationScanOptions) => {
  const candidatesFor = (direction: CitationDirection) => {
    const window = workCitationStream({
      tx,
      work,
      direction,
      fields: {
        doctrinalTreatment: doctrinalTreatmentField(doctrineAvailable),
        evidenceQuote: NO_EVIDENCE_QUOTE,
      },
      limit: CITATION_SUMMARY_SCAN_LIMIT + 1,
    });
    return { window, canonical: window.canonical };
  };

  const { window: incomingCandidates, canonical: incomingCanonical } =
    candidatesFor("incoming");
  const relatedDecision = relatedDecisionLookup(
    tx,
    incomingCandidates.relatedId,
  );
  const firstYear = currentYear - (CITATION_TIMELINE_MAX_YEARS - 1);
  const citingYearInSpan = sql<number | null>`CASE
    WHEN ${relatedDecision.decisionDate} >= make_date(${firstYear}::int, 1, 1)
     AND ${relatedDecision.decisionDate} < make_date(${currentYear + 1}::int, 1, 1)
    THEN extract(year from ${relatedDecision.decisionDate})::int
  END`;
  const incomingVisible = visibleFor({
    countries,
    keepsUnresolved: false,
    related: incomingCandidates.relatedId,
    country: relatedDecision.country,
  });

  const incoming = tx
    .select({
      direction: sql<CitationDirection>`'incoming'`.as("direction"),
      year: citingYearInSpan.as("year"),
      polarity: incomingCandidates.polarity,
      doctrinalTreatment: incomingCandidates.doctrinalTreatment,
      count:
        sql<number>`count(*) FILTER (WHERE ${incomingCandidates.ordinal} <= ${CITATION_SUMMARY_SCAN_LIMIT} AND ${eq(incomingCandidates.kind, CITATION_KIND.PRECEDENT)} AND ${incomingVisible} AND ${incomingCanonical})::int`.as(
          "count",
        ),
      capped:
        sql<boolean>`bool_or(${incomingCandidates.ordinal} > ${CITATION_SUMMARY_SCAN_LIMIT})`.as(
          "capped",
        ),
    })
    .from(incomingCandidates)
    .leftJoinLateral(relatedDecision, sql`true`)
    .leftJoin(relatedSource, eq(relatedSource.id, relatedDecision.sourceId))
    // By ordinal: the year expression binds its bounds as parameters, and
    // a second rendering would bind fresh ones the planner cannot match.
    .groupBy(
      sql`2`,
      incomingCandidates.polarity,
      incomingCandidates.doctrinalTreatment,
    );

  const { window: outgoingCandidates, canonical: outgoingCanonical } =
    candidatesFor("outgoing");
  const outgoingDecision = relatedDecisionLookup(
    tx,
    outgoingCandidates.relatedId,
  );
  const outgoingVisible = visibleFor({
    countries,
    keepsUnresolved: true,
    related: outgoingCandidates.relatedId,
    country: outgoingDecision.country,
  });

  const outgoing = tx
    .select({
      direction: sql<CitationDirection>`'outgoing'`.as("direction"),
      year: sql<number | null>`NULL::int`.as("year"),
      polarity: outgoingCandidates.polarity,
      doctrinalTreatment: outgoingCandidates.doctrinalTreatment,
      count:
        sql<number>`count(*) FILTER (WHERE ${outgoingCandidates.ordinal} <= ${CITATION_SUMMARY_SCAN_LIMIT} AND ${eq(outgoingCandidates.kind, CITATION_KIND.PRECEDENT)} AND ${outgoingVisible} AND ${outgoingCanonical})::int`.as(
          "count",
        ),
      capped:
        sql<boolean>`bool_or(${outgoingCandidates.ordinal} > ${CITATION_SUMMARY_SCAN_LIMIT})`.as(
          "capped",
        ),
    })
    .from(outgoingCandidates)
    .leftJoinLateral(outgoingDecision, sql`true`)
    .leftJoin(relatedSource, eq(relatedSource.id, outgoingDecision.sourceId))
    .groupBy(
      outgoingCandidates.polarity,
      outgoingCandidates.doctrinalTreatment,
    );

  /**
   * The few decisions citing this one a reader should see first, one row per
   * decision however often it cites the case: the most authoritative by the
   * materialized citation authority search ranks by, the most recent among
   * equals. Only citations the counts above count take part, so a citing
   * judgment appears once, as the version that holds its canonical rows.
   */
  const topCiting = (limit: number) => {
    const { window: candidates, canonical } = candidatesFor("incoming");
    const citingDecision = relatedDecisionLookup(tx, candidates.relatedId);
    const publishedBy = eq(relatedSource.id, citingDecision.sourceId);
    const columns = {
      id: citingDecision.id,
      caseNumber: citingDecision.caseNumber,
      caseNumberType: citingDecision.caseNumberType,
      country: citingDecision.country,
      court: citingDecision.court,
      courtId: citingDecision.courtId,
      sourceUrl: citingDecision.sourceUrl,
      decisionDate: citingDecision.decisionDate,
      decisionType: citingDecision.decisionType,
      ecli: citingDecision.ecli,
      language: citingDecision.language,
      languageGroupKey: citingDecision.languageGroupKey,
      slug: citingDecision.slug,
      citationAuthority: citingDecision.citationAuthority,
    };
    return tx
      .select(columns)
      .from(candidates)
      .innerJoinLateral(citingDecision, sql`true`)
      .innerJoin(relatedSource, publishedBy)
      .where(
        and(
          lte(candidates.ordinal, CITATION_SUMMARY_SCAN_LIMIT),
          eq(candidates.kind, CITATION_KIND.PRECEDENT),
          visibleFor({
            countries,
            keepsUnresolved: false,
            related: candidates.relatedId,
            country: citingDecision.country,
          }),
          canonical,
        ),
      )
      .groupBy(...Object.values(columns))
      .orderBy(
        desc(citingDecision.citationAuthority),
        sql`${citingDecision.decisionDate} DESC NULLS LAST`,
        asc(citingDecision.id),
      )
      .limit(limit);
  };

  return {
    // One row per (direction, year-or-null, stored polarity): the span and
    // the polarity check constraint already cap it, this states the cap.
    summary: unionAll(incoming, outgoing).limit(
      (CITATION_TIMELINE_MAX_YEARS + 2) *
        (POLARITIES.length + 1) *
        (DOCTRINAL_TREATMENTS.length + 1),
    ),
    topCiting,
    incomingWindowOverflow: tx
      .select({ ordinal: incomingCandidates.ordinal })
      .from(incomingCandidates)
      .where(gt(incomingCandidates.ordinal, CITATION_SUMMARY_SCAN_LIMIT))
      .limit(1),
  };
};

type DoctrineCounts = Record<DoctrineTreatment | "unread", number>;

export type DecisionDoctrineSummary =
  | { status: "unavailable" }
  | {
      status: "available";
      counts: Record<CitationDirection, DoctrineCounts>;
      capped: Record<CitationDirection, boolean>;
      candidateWindow: typeof CITATION_SUMMARY_SCAN_LIMIT;
    };

export const summarizeDecisionDoctrineHandler = async ({
  subject,
}: SummarizeDecisionCitationsOptions): Promise<DecisionDoctrineSummary> => {
  const { countries, tx } = subject;
  if (!(await canReadCitationDoctrine(tx))) {
    return { status: "unavailable" };
  }
  const rows = await decisionCitationSummaryQuery({
    currentYear: 0,
    work: await decisionWorkOf(subject),
    countries,
    tx,
    doctrineAvailable: true,
  }).summary;
  const countOf = (
    direction: CitationDirection,
    treatment: DoctrineTreatment | "unread",
  ) => {
    let total = 0;
    for (const row of rows) {
      if (
        row.direction === direction &&
        (row.doctrinalTreatment ?? "unread") === treatment
      ) {
        total += row.count;
      }
    }
    return total;
  };
  const countsFor = (direction: CitationDirection): DoctrineCounts => ({
    distinguishes: countOf(direction, "distinguishes"),
    limits: countOf(direction, "limits"),
    not_stated: countOf(direction, "not_stated"),
    unread: countOf(direction, "unread"),
  });
  const cappedFor = (direction: CitationDirection) =>
    rows.some((row) => row.direction === direction && row.capped);
  return {
    status: "available",
    counts: {
      incoming: countsFor("incoming"),
      outgoing: countsFor("outgoing"),
    },
    capped: {
      incoming: cappedFor("incoming"),
      outgoing: cappedFor("outgoing"),
    },
    candidateWindow: CITATION_SUMMARY_SCAN_LIMIT,
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
  subject,
  summary,
  limit,
}: TopCitingDecisionsOptions): Promise<TopCitingDecisionsResult> => {
  const { countries, tx } = subject;
  const query = decisionCitationSummaryQuery({
    currentYear: TOP_CITING_TIMELINE_YEAR,
    work: await decisionWorkOf(subject),
    countries,
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

export const listLeadingCitationsQuerySchema = v.object({
  direction: v.picklist(CITATION_DIRECTIONS),
});

type ListLeadingCitationsQuery = v.InferOutput<
  typeof listLeadingCitationsQuerySchema
>;

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
const treatmentSqlFor = (polarity: SQLWrapper) => sql<string>`CASE
  WHEN ${polarity} IS NULL
    OR ${polarity} = ${sql.raw(`'${POLARITY.UNKNOWN}'`)}
  THEN 'unclassified'
  ELSE ${polarity}
END`;

/**
 * The few decisions per treatment a reader should see first: the most
 * authoritative decisions citing this one (or cited by it), one row per
 * decision even where it cites the case several times. Ranked by the far
 * decision's materialized citation authority, which search ranks by too,
 * so the two surfaces agree on what "leading" means.
 *
 * A decision that is its work's only version ranks every edge it holds. A
 * work of several versions holds each citation once per version that prints
 * it, so its leaders are ranked within the same bounded window the summary
 * counts; a far decision appears once, as the version holding the canonical
 * rows.
 */
export const listLeadingCitationsHandler = async ({
  subject,
  query,
}: ListLeadingCitationsOptions): Promise<{ items: LeadingCitationRow[] }> => {
  const { countries, tx } = subject;
  const work = await decisionWorkOf(subject);
  const window = workCitationStream({
    tx,
    work,
    direction: query.direction,
    fields: {
      doctrinalTreatment: doctrinalTreatmentField(false),
      evidenceQuote: NO_EVIDENCE_QUOTE,
    },
    where: precedentOnly,
    limit: isSingleManifestationWork(work)
      ? undefined
      : CITATION_SUMMARY_SCAN_LIMIT,
  });
  const relatedDecision = relatedDecisionLookup(tx, window.relatedId);
  const treatment = treatmentSqlFor(window.polarity);

  // One row per (treatment, far decision): its first citation in the text.
  const mentions = tx
    .select({
      id: window.id,
      citationText: window.citationText,
      sectionIndex: window.sectionIndex,
      polarity: window.polarity,
      treatment: treatment.as("treatment"),
      relatedId: sql<string>`${window.relatedId}`.as("leading_related_id"),
      authority: relatedDecision.citationAuthority,
      mentionRank: sql<number>`row_number() OVER (
        PARTITION BY ${treatment}, ${window.relatedId}
        ORDER BY ${window.id}
      )`.as("mention_rank"),
    })
    .from(window)
    .innerJoinLateral(relatedDecision, sql`true`)
    .innerJoin(relatedSource, eq(relatedSource.id, relatedDecision.sourceId))
    .where(
      and(
        // Before ranking, so a hidden decision cannot take a leader's place.
        // Only a held decision can lead, whatever the direction keeps.
        visibleFor({
          countries,
          keepsUnresolved: false,
          related: window.relatedId,
          country: relatedDecision.country,
        }),
        window.canonical,
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
  const rankedDecision = relatedDecisionLookup(
    tx,
    sql`${ranked.relatedId}::uuid`,
  );

  const rows = await tx
    .select({
      id: ranked.id,
      citationText: ranked.citationText,
      sectionIndex: ranked.sectionIndex,
      polarity: ranked.polarity,
      decision: {
        id: rankedDecision.id,
        caseNumber: rankedDecision.caseNumber,
        caseNumberType: rankedDecision.caseNumberType,
        country: rankedDecision.country,
        court: rankedDecision.court,
        courtId: rankedDecision.courtId,
        sourceUrl: rankedDecision.sourceUrl,
        decisionDate: rankedDecision.decisionDate,
        decisionType: rankedDecision.decisionType,
        ecli: rankedDecision.ecli,
        language: rankedDecision.language,
        languageGroupKey: rankedDecision.languageGroupKey,
        slug: rankedDecision.slug,
        citationAuthority: rankedDecision.citationAuthority,
      },
    })
    .from(ranked)
    .innerJoinLateral(rankedDecision, sql`true`)
    .where(and(sql`${ranked.rank} <= ${LEADING_CITATIONS_PER_TREATMENT}`))
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
