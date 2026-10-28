/**
 * The work a decision row belongs to: one judgment, however many language
 * versions of it the corpus holds.
 *
 * Every language version (manifestation) of a decision is its own
 * `case_law_decisions` row, and every citation row belongs to one of them:
 * the version whose text printed it, and on the cited side the version the
 * resolver chose for the citing language. Counted per row, a judgment cited
 * by one Czech and one German judgment reads "1" in each language, and the
 * references a version's text carries are listed only on that version. A
 * citation read is a read about the judgment, so it anchors on the work and
 * counts each citation of the work once. This module is the one place that
 * says which rows are one work and which citation rows are one citation;
 * `case-law-citation-work-anchor.test.ts` keeps citation reads from anchoring
 * on a single row anywhere else.
 *
 * **Which rows are one work.** Rows sharing `language_group_key` are versions
 * of one judgment, with one exception: the key falls back to the source's
 * docket where a decision has no ECLI, and one docket can hold several
 * decisions. Two rows of one language in one group are therefore distinct
 * decisions, never one work. A row is a version of a multilingual work only
 * when its own language, and every other member's, occurs exactly once among
 * the group's public rows; any other row is a work of its own. The relation is
 * an equivalence, so every member computes the same member set and every
 * member reads the same citations. A group holding more public rows than
 * `DECISION_WORK_MANIFESTATIONS_MAX` is treated as malformed: each of its rows
 * stands alone, which keeps the read bounded without picking a subset.
 *
 * **Which citation rows are one citation.** Each version of the citing
 * judgment carries its own rows for the same references. An edge's identity is
 * its citing work, its kind, and what it names: the cited work when it is
 * resolved, else its printed text. Of the versions holding an identity, the
 * one with the lowest decision id owns it, and all of that version's rows with
 * the identity are canonical (two mentions in one text stay two rows); the
 * other versions' rows are duplicates. The cited work rather than a printed
 * key is the identity for a resolved edge, because the public reader holds no
 * grant on the stored citation keys and because a version that resolved the
 * reference must not lose the edge to one that did not. Rivals are probed
 * through the citing versions' own outgoing rows (`case_law_citations_citing_page_idx`),
 * which are small, never through the cited side.
 */
import { panic } from "better-result";
import { and, asc, eq, gt, sql } from "drizzle-orm";
import type { SQL, SQLWrapper } from "drizzle-orm";

import {
  caseLawCitations,
  caseLawSources,
  publishedCaseLawDecisions,
} from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import type { CaseLawPublicReadTransaction } from "@/api/lib/case-law-public-read-db";
import type { CitationDirection } from "@/api/lib/case-law/citation-vocabulary";
import type { DoctrineTreatment } from "@/api/lib/case-law/doctrine";
import type { RedistributableDecisionSubject } from "@/api/lib/case-law/public-subject";
import { redistributableCaseLawSourceFor } from "@/api/lib/case-law/redistribution";
import { LIMITS } from "@/api/lib/limits";
import { brandPersistedCaseLawDecisionId } from "@/api/lib/safe-id-boundaries";

/**
 * The judgment a row names by its stored grouping alone: its language group,
 * else the row itself. The resolver keeps one candidate per such key; reads
 * narrow it with the same-language guard in `decisionWorkMembersSql`.
 */
export const languageGroupWorkKey = ({
  decisionId,
  languageGroupKey,
}: {
  decisionId: string;
  languageGroupKey: string | null;
}): string =>
  languageGroupKey === null
    ? `decision:${decisionId}`
    : `group:${languageGroupKey}`;

/** `languageGroupWorkKey` over a row the statement reads. */
export const languageGroupWorkKeySql = ({
  id,
  languageGroupKey,
}: {
  id: SQLWrapper;
  languageGroupKey: SQLWrapper;
}): SQL<string> =>
  sql<string>`CASE
             WHEN ${languageGroupKey} IS NULL
               THEN 'decision:' || ${id}::text
             ELSE 'group:' || ${languageGroupKey}
           END`;

/** Public rows of one group a work may span; more marks the group malformed. */
export const DECISION_WORK_MANIFESTATIONS_MAX =
  LIMITS.caseLawLanguageAlternatesPerGroupMax;

/**
 * The ids of every version of the work `decisionId` belongs to, the decision
 * itself included, as a subquery with one `id` column. Correlated use is the
 * point: the expression may name a column of the enclosing statement.
 *
 * The group read is bounded without an order: it fetches one row past the
 * ceiling, and a group that fills it is treated as malformed whichever rows
 * came back, so the answer never depends on which subset the scan returned.
 */
export const decisionWorkMembersSql = (decisionId: SQLWrapper): SQL => sql`
  SELECT ${decisionId}::uuid AS id
  UNION
  SELECT work_member.id
    FROM (
      SELECT work_group.id,
             count(*) OVER () AS group_size,
             count(*) OVER (PARTITION BY work_group.language) AS language_size,
             count(*) FILTER (WHERE work_group.language = work_group.subject_language) OVER ()
               AS subject_language_size,
             bool_or(work_group.id = work_group.subject_id) OVER () AS holds_subject
        FROM (
          SELECT work_version.id,
                 work_version.language,
                 work_subject.id AS subject_id,
                 work_subject.language AS subject_language
            FROM (
              SELECT subject_row.id,
                     subject_row.language,
                     subject_row.language_group_key
                FROM ${publishedCaseLawDecisions} subject_row
               WHERE subject_row.id = ${decisionId}
               LIMIT 1
            ) work_subject
            CROSS JOIN LATERAL (
              SELECT group_row.id, group_row.language
                FROM ${publishedCaseLawDecisions} group_row
                JOIN ${caseLawSources} group_row_source
                  ON group_row_source.id = group_row.source_id
                 AND ${redistributableCaseLawSourceFor(sql`group_row_source.descriptor`)}
               WHERE group_row.language_group_key = work_subject.language_group_key
               LIMIT ${DECISION_WORK_MANIFESTATIONS_MAX + 1}
            ) work_version
        ) work_group
    ) work_member
   WHERE work_member.group_size <= ${DECISION_WORK_MANIFESTATIONS_MAX}
     AND work_member.language_size = 1
     AND work_member.subject_language_size = 1
     AND work_member.holds_subject`;

/** The versions of one decision's work, read once for a request. */
export type DecisionWork = {
  readonly subjectId: SafeId<"caseLawDecision">;
  /** Ascending by id; always holds the subject. */
  readonly manifestationIds: readonly SafeId<"caseLawDecision">[];
};

/**
 * The scope of a read about one version's own text rather than about the
 * judgment: the reader locates inline citation links in the text it shows, so
 * it reads exactly the rows that text prints. Every read about the judgment
 * takes the work from `readDecisionWork` instead.
 */
export const ownTextScope = (
  decisionId: SafeId<"caseLawDecision">,
): DecisionWork => ({ subjectId: decisionId, manifestationIds: [decisionId] });

/** Whether the work is the subject alone, so no other version can hold its edges. */
export const isSingleManifestationWork = (work: DecisionWork): boolean =>
  work.manifestationIds.length === 1;

/**
 * Whether a read in this direction can meet another version's copy of a row.
 * An incoming row always can, from the versions of the citing judgment. The
 * subject's own outgoing rows cannot when no other version of it holds rows:
 * the rule is then true by construction, and the read keeps its single-range
 * shape.
 */
export const canonicalRuleApplies = (
  direction: CitationDirection,
  work: DecisionWork,
): boolean => direction === "incoming" || !isSingleManifestationWork(work);

/** The statement `readDecisionWork` runs; the query-plan registry reads it. */
export const decisionWorkQuery = (
  tx: Pick<CaseLawPublicReadTransaction, "select">,
  subjectId: SafeId<"caseLawDecision">,
) =>
  tx
    .select({ id: sql<string>`decision_work.id` })
    .from(sql`(${decisionWorkMembersSql(sql`${subjectId}`)}) AS decision_work`)
    .orderBy(sql`decision_work.id`)
    // The subject plus at most the ceiling: the member set states its bound.
    .limit(DECISION_WORK_MANIFESTATIONS_MAX + 1);

export const readDecisionWork = async (
  tx: Pick<CaseLawPublicReadTransaction, "select">,
  subjectId: SafeId<"caseLawDecision">,
): Promise<DecisionWork> => {
  const rows = await decisionWorkQuery(tx, subjectId);
  const ids = rows.map((row) => brandPersistedCaseLawDecisionId(row.id));
  if (!ids.includes(subjectId)) {
    return panic("A decision's work must hold the decision itself");
  }
  return { subjectId, manifestationIds: ids };
};

const workBySubject = new WeakMap<
  RedistributableDecisionSubject,
  Promise<DecisionWork>
>();

/**
 * The gated subject's work, read in its transaction once however many citation
 * reads the request makes. Keyed by the subject object, which lives exactly as
 * long as the request's snapshot, so a later request never sees this answer.
 */
export const decisionWorkOf = async (
  subject: RedistributableDecisionSubject,
): Promise<DecisionWork> => {
  const cached = workBySubject.get(subject);
  if (cached !== undefined) {
    return await cached;
  }
  const read = readDecisionWork(subject.tx, subject.id);
  workBySubject.set(subject, read);
  return await read;
};

/** The work's version ids as a `uuid[]` expression. */
export const decisionWorkIdsSql = (work: DecisionWork): SQL =>
  sql`ARRAY[${sql.join(
    work.manifestationIds.map((id) => sql`${id}`),
    sql`, `,
  )}]::uuid[]`;

/** Which end of a citation row a read anchors on, and which end it shows. */
export const CITATION_WORK_ENDPOINTS = {
  incoming: {
    anchor: caseLawCitations.citedDecisionId,
    related: caseLawCitations.citingDecisionId,
  },
  outgoing: {
    anchor: caseLawCitations.citingDecisionId,
    related: caseLawCitations.citedDecisionId,
  },
} as const satisfies Record<
  CitationDirection,
  {
    anchor:
      | typeof caseLawCitations.citedDecisionId
      | typeof caseLawCitations.citingDecisionId;
    related:
      | typeof caseLawCitations.citedDecisionId
      | typeof caseLawCitations.citingDecisionId;
  }
>;

const ANCHOR_COLUMNS = {
  incoming: sql`anchored.cited_decision_id`,
  outgoing: sql`anchored.citing_decision_id`,
} as const satisfies Record<CitationDirection, SQL>;

/**
 * A FROM fragment for a raw statement: the citation rows anchored on the work
 * whose version ids `workIds` (a `uuid[]` expression) holds, under the alias
 * `anchored`, one anchor index range per version.
 */
export const workAnchoredCitationsSql = ({
  direction,
  workIds,
}: {
  direction: CitationDirection;
  workIds: SQL;
}): SQL =>
  sql`unnest(${workIds}) AS work_anchor(id)
      JOIN ${caseLawCitations} anchored
        ON ${ANCHOR_COLUMNS[direction]} = work_anchor.id`;

/** The work of `decisionId` (a SQL expression) as a `uuid[]` expression. */
export const decisionWorkIdArraySql = (decisionId: SQLWrapper): SQL =>
  sql`ARRAY(${decisionWorkMembersSql(decisionId)})`;

/** The columns of one citation row the canonical rule reads. */
export type CitationIdentityColumns = {
  citingDecisionId: SQLWrapper;
  citedDecisionId: SQLWrapper;
  kind: SQLWrapper;
  citationText: SQLWrapper;
};

type CanonicalWorkCitationOptions = {
  /** The work the read anchors on, and so which end the row shares with it. */
  direction: CitationDirection;
  /** The anchored work's version ids as a `uuid[]` expression. */
  workIds: SQL;
  row: CitationIdentityColumns;
};

/**
 * Whether a row anchored on the work is the canonical copy of its citation:
 * no version of its citing judgment with a lower decision id holds a row of
 * the same kind naming the same thing.
 *
 * Incoming, the row names the anchored work itself, so a rival is any row of
 * an earlier version of the citing judgment into the work. Outgoing, the
 * citing judgment is the anchored work, and a rival names the same cited work
 * (or, unresolved, prints the same text). Either way the probe walks the
 * earlier citing versions' outgoing rows, at most the work ceiling of them.
 */
export const canonicalWorkCitationSql = ({
  direction,
  workIds,
  row,
}: CanonicalWorkCitationOptions): SQL<boolean> => {
  switch (direction) {
    case "incoming":
      return sql<boolean>`NOT EXISTS (
        SELECT 1
          FROM (${decisionWorkMembersSql(row.citingDecisionId)}) citing_version
          JOIN ${caseLawCitations} canonical_rival
            ON canonical_rival.citing_decision_id = citing_version.id
         WHERE citing_version.id < ${row.citingDecisionId}
           AND canonical_rival.kind = ${row.kind}
           AND canonical_rival.cited_decision_id = ANY (${workIds})
      )`;
    case "outgoing":
      return sql<boolean>`NOT EXISTS (
        SELECT 1
          FROM (
            SELECT coalesce(array_agg(cited_version.id), ARRAY[]::uuid[]) AS ids
              FROM (${decisionWorkMembersSql(row.citedDecisionId)}) cited_version
             WHERE ${row.citedDecisionId} IS NOT NULL
          ) cited_work
          JOIN ${caseLawCitations} canonical_rival
            ON canonical_rival.citing_decision_id = ANY (${workIds})
         WHERE canonical_rival.citing_decision_id < ${row.citingDecisionId}
           AND canonical_rival.kind = ${row.kind}
           AND (
                 (${row.citedDecisionId} IS NULL
                   AND canonical_rival.cited_decision_id IS NULL
                   AND canonical_rival.citation_text = ${row.citationText})
              OR canonical_rival.cited_decision_id = ANY (cited_work.ids)
               )
      )`;
    default: {
      direction satisfies never;
      return panic(`Unhandled citation direction: ${String(direction)}`);
    }
  }
};

/**
 * What a work-anchored read selects from each citation row besides its id and
 * identity columns. The doctrine fields are computed by the caller, which
 * alone knows whether its reader holds the doctrine grants.
 */
export type WorkCitationFields = {
  doctrinalTreatment: SQL.Aliased<DoctrineTreatment | null>;
  evidenceQuote: SQL.Aliased<string | null>;
};

/** For a read that shows no doctrine: both columns NULL. */
const NO_DOCTRINE_FIELDS: WorkCitationFields = {
  doctrinalTreatment: sql<DoctrineTreatment | null>`NULL::varchar`.as(
    "doctrinal_treatment",
  ),
  evidenceQuote: sql<string | null>`NULL::text`.as("evidence_quote"),
};

type WorkCitationStreamOptions = {
  tx: Pick<CaseLawPublicReadTransaction, "select">;
  work: DecisionWork;
  direction: CitationDirection;
  /** Defaults to no doctrine. */
  fields?: WorkCitationFields;
  /** Row filters the read applies before the window counts a row. */
  where?: SQL | undefined;
  /** Keyset position: rows after this citation id. */
  after?: SafeId<"caseLawCitation"> | undefined;
  /**
   * Rows the window holds: the bound on what one read examines. Omitted only
   * by a read of a single version's whole range, which its index bounds.
   */
  limit: number | undefined;
};

/**
 * The work's citation rows in citation-id order: the first `limit` rows
 * anchored on any of its versions, each with its 1-based `ordinal` in the
 * window, the far end as `relatedId`, and `canonical`: whether the row is the
 * copy of its citation the work counts (`canonicalWorkCitationSql`).
 *
 * One version reads its own anchor index range. Several are one index range
 * each under a merge on citation id, so the window reads `limit` rows however
 * many edges the work holds; `= ANY` over the versions would read them all
 * before it could order them.
 */
export const workCitationStream = ({
  tx,
  work,
  direction,
  fields = NO_DOCTRINE_FIELDS,
  where,
  after,
  limit,
}: WorkCitationStreamOptions) => {
  const { anchor, related } = CITATION_WORK_ENDPOINTS[direction];
  if (limit === undefined && !isSingleManifestationWork(work)) {
    return panic("A read over several versions needs a window");
  }
  const branch = (manifestationId: SafeId<"caseLawDecision">) =>
    tx
      .select({
        id: caseLawCitations.id,
        citationText: caseLawCitations.citationText,
        sectionIndex: caseLawCitations.sectionIndex,
        polarity: caseLawCitations.polarity,
        doctrinalTreatment: fields.doctrinalTreatment,
        evidenceQuote: fields.evidenceQuote,
        relatedId: sql<SafeId<"caseLawDecision"> | null>`${related}`.as(
          "related_id",
        ),
        citingDecisionId: sql<
          SafeId<"caseLawDecision">
        >`${caseLawCitations.citingDecisionId}`.as("edge_citing_decision_id"),
        citedDecisionId:
          sql<SafeId<"caseLawDecision"> | null>`${caseLawCitations.citedDecisionId}`.as(
            "edge_cited_decision_id",
          ),
        kind: caseLawCitations.kind,
      })
      .from(caseLawCitations)
      .where(
        and(
          eq(anchor, manifestationId),
          where,
          after === undefined ? undefined : gt(caseLawCitations.id, after),
        ),
      );
  const [first, ...rest] = work.manifestationIds.map(branch);
  if (first === undefined) {
    return panic("A work holds at least its subject");
  }
  const merged = first.$dynamic();
  for (const next of rest) {
    merged.unionAll(next);
  }
  const anchored = merged.as("work_citation_rows");
  // The cap sits directly over the anchor ranges, so each range reads at most
  // `limit` rows; numbering and the canonical rule read the capped rows.
  const capped = tx
    .select({
      id: anchored.id,
      citationText: anchored.citationText,
      sectionIndex: anchored.sectionIndex,
      polarity: anchored.polarity,
      doctrinalTreatment: anchored.doctrinalTreatment,
      evidenceQuote: anchored.evidenceQuote,
      relatedId: anchored.relatedId,
      citingDecisionId: anchored.citingDecisionId,
      citedDecisionId: anchored.citedDecisionId,
      kind: anchored.kind,
    })
    .from(anchored)
    .$dynamic();
  if (limit !== undefined) {
    capped.orderBy(asc(anchored.id)).limit(limit);
  }
  const rows = capped.as("work_citation_capped");
  const canonical = canonicalRuleApplies(direction, work)
    ? canonicalWorkCitationSql({
        direction,
        workIds: decisionWorkIdsSql(work),
        row: {
          citingDecisionId: rows.citingDecisionId,
          citedDecisionId: rows.citedDecisionId,
          kind: rows.kind,
          citationText: rows.citationText,
        },
      })
    : sql<boolean>`true`;
  return tx
    .select({
      id: rows.id,
      citationText: rows.citationText,
      sectionIndex: rows.sectionIndex,
      polarity: rows.polarity,
      doctrinalTreatment: rows.doctrinalTreatment,
      evidenceQuote: rows.evidenceQuote,
      relatedId: rows.relatedId,
      citingDecisionId: rows.citingDecisionId,
      citedDecisionId: rows.citedDecisionId,
      kind: rows.kind,
      ordinal: sql<number>`row_number() OVER (ORDER BY ${rows.id})`.as(
        "ordinal",
      ),
      // Computed here, once per row the window yields: the window is never
      // flattened into its reader (it holds a window function), so a filter
      // and a count over it read this column instead of probing again.
      canonical: canonical.as("canonical"),
    })
    .from(rows)
    .as("work_citation_window");
};

export type WorkCitationWindow = ReturnType<typeof workCitationStream>;
