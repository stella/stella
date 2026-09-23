/**
 * Citation resolution: link a citation to the decision it cites.
 *
 * Both sides carry the same typed, canonical identifier. Docket-only legacy
 * rows keep their `citation_key` bridge until the bounded identifier backfill
 * projects them. Resolution is therefore an indexed equality join rather
 * than a scan. The work happens inside one statement per batch: nothing about
 * it scales with corpus size, and a run can stop and resume anywhere.
 *
 * Every rule that keeps a link honest is a filter in the join rather than a
 * check afterwards:
 *
 * - **Jurisdiction.** A case number is only unique within its own court
 *   system; the same string means different cases in different countries.
 *   Which corpora a citation may reach is declared per jurisdiction in
 *   `citation-jurisdiction-policy.ts`, not decided here.
 * - **Time.** A decision cannot cite one published after it. This is the
 *   rule that catches a coincidental key collision with a later case, which
 *   is otherwise indistinguishable from a real citation.
 * - **Uniqueness.** A key matching more than one decision is ambiguous, and
 *   an ambiguous link is worse than none: it puts a wrong edge in the
 *   citation graph and thus a wrong number in the authority ranking. Those
 *   rows are recorded as `ambiguous` for the adjudication tier to pick up.
 * - **The text names the sheet.** The first adjudication rule, and the only
 *   one that reads an identity rather than a word. One docket names a case
 *   file, and a court can rule in it more than once, so the docket alone
 *   leaves those decisions indistinguishable. The court names the one it
 *   means by the sheet the document sits on — "č. j. 8 As 287/2020-33" — and
 *   that sheet is the last segment of the decision's ECLI. When exactly one
 *   time-valid candidate answers to it, the link goes there.
 * - **The text names the date.** The second adjudication rule, for the
 *   citations that print no sheet: "rozsudek … ze dne 17. 2. 2021, č. j. …".
 *   When exactly one candidate carries that date, the link goes there. Two
 *   decisions of one file issued on one day leave the row ambiguous, which is
 *   what it is.
 * - **The text names the type.** The third adjudication rule. A citation is
 *   usually introduced with the decision's type ("nález sp. zn. …",
 *   "usnesením … č. j. …"); the extractor keeps that word as
 *   `cited_decision_type_hint`. When the key has several time-valid holders
 *   and exactly one is of the named type, the link goes there: no inference,
 *   the citing court said so. A hint that names none of them is a word the
 *   corpus cannot use and the next rule applies; one that names several
 *   leaves the row ambiguous, since the next rule would contradict the text.
 * - **The text names the court.** The fourth adjudication rule. Regional
 *   courts number files independently, so `65 A 3/2025` exists at several of
 *   them and the key alone never links a citation of a regional decision.
 *   The citing sentence says which court ("rozsudek Krajského soudu v
 *   Českých Budějovicích ze dne …, č. j. …"); the extractor keeps that
 *   phrase as `cited_court_hint`, and when exactly one time-valid holder
 *   sits at that court the link goes there. Both sides are compared through
 *   one normalization (`courtNameKeySql`), since the phrase is inflected and
 *   the stored name is not.
 * - **One file, one merits decision.** The fifth adjudication rule, and the
 *   one structural exception to uniqueness. A constitutional court keeps one
 *   docket number for a whole file, so the nález on the merits and the
 *   procedural orders issued along the way all canonicalize to the same key.
 *   A citation of that key means the nález: nobody cites an interim order by
 *   the file number alone. When every time-valid candidate sits at one court
 *   and exactly one of them is a merits decision while all the others are
 *   procedural orders, the link goes to the merits decision. Any other mix
 *   (two nálezy, an untyped candidate, a second court) stays ambiguous.
 *
 * The outcome lands in `resolution_status`, not in the nullability of
 * `cited_decision_id`. A null foreign key cannot distinguish "not examined
 * yet" from "examined, nothing honest to link to", so the scan's predicate
 * never emptied and every unresolvable row was re-examined on every pass
 * forever. With the outcome recorded, the pending set burns down.
 *
 * Two structural bounds keep one batch's cost independent of how popular a
 * key is: candidates are read through a `LATERAL (… LIMIT cap)` (a handful is
 * all uniqueness and the one-file rule need to know; a key held by more is
 * ambiguous without looking further), and the walk is a strict keyset over
 * `(citing_decision_id, id)`. The citing-side axis is deliberate: citation
 * ids and decision ids are both uuidv7, so walking citations in citing-
 * decision order reads the decisions table in insertion order rather than at
 * random.
 */

import { panic } from "better-result";
import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

import type { CaseLawJurisdiction } from "@stll/api-contract/case-law-jurisdictions";
import type { DecisionIdentifierType } from "@stll/legal-ast/decision-identifier";

import type { ScopedDb } from "@/api/db/safe-db";
import {
  caseLawCitationResolutionProgress,
  caseLawCitations,
  caseLawDecisionIdentifiers,
  caseLawDecisions,
} from "@/api/db/schema";
import { courtNameKeySql } from "@/api/handlers/case-law/citation-court-hint";
import {
  CITATION_DECISION_TYPE_HINT_FAMILIES,
  CITATION_DECISION_TYPE_HINTS,
} from "@/api/handlers/case-law/citation-decision-type-hint";
import { citationResolutionPolicyRows } from "@/api/handlers/case-law/citation-jurisdiction-policy";
import {
  CITATION_RESOLUTION_RULE,
  CITATION_RESOLUTION_RULES,
  CITATION_RESOLUTION_SCOPE,
  CITATION_RESOLUTION_STATUS,
  CITATION_RESOLUTION_STATUSES,
  type CitationResolutionRule,
  type CitationResolutionStatus,
  CITATION_CANDIDATE_SCAN_CAP,
  citationReopenableByKeySql,
  countsByRule,
  MERITS_DECISION_TYPES,
  PROCEDURAL_DECISION_TYPES,
  unsettledCitationSql,
} from "@/api/handlers/case-law/citation-resolution-status";
import type { SafeId } from "@/api/lib/branded-types";
import { brandPersistedCaseLawDecisionId } from "@/api/lib/safe-id-boundaries";
import { isRecord } from "@/api/lib/type-guards";

/**
 * Structural, not the `Transaction` type: the pipeline passes its open
 * transaction and the tests pass a pglite handle, and importing the concrete
 * type would pull the connection singleton into a module that only ever
 * executes SQL. Same shape the citation-authority recompute takes.
 */
type CitationResolutionTx = {
  execute: (query: SQL) => Promise<unknown>;
};

const decisionTypeArray = (types: readonly string[]): SQL =>
  sql`ARRAY[${sql.join(
    types.map((type) => sql`${type}`),
    sql`, `,
  )}]::varchar[]`;

/**
 * A candidate that answers to the sheet number the citing text printed.
 *
 * Two published spellings carry it, and a court uses whichever it uses. The
 * ECLI's last segment is the sheet
 * (`ECLI:CZ:NSS:2021:8.As.287.2020.33` is sheet 33 of `8 As 287/2020`), and a
 * publisher that supplies the full file number instead leaves it on a
 * `case-number` identifier row, where docket normalisation keeps the sheet on
 * the key. Both are matched by concatenation rather than a pattern built from
 * the column, so the sheet travels as a bind parameter; the column's CHECK
 * keeps it to digits, which carry no `LIKE` metacharacter.
 */
const sheetMatchSql = sql`
  b.cited_sheet_number IS NOT NULL
  AND (
        k.ecli LIKE ('%.' || b.cited_sheet_number)
     OR EXISTS (
          SELECT 1
          FROM ${caseLawDecisionIdentifiers} sheet_identifier
          WHERE sheet_identifier.decision_id = k.id
            AND sheet_identifier.type = 'case-number'
            AND sheet_identifier.normalized_value
                  LIKE ('%-' || b.cited_sheet_number)
        )
      )`;

/**
 * The hint vocabulary as a CTE, one row per family: which stored
 * `decision_type` spellings a citation's hint names. Built per call from the
 * same constants the extractor writes, so the two cannot drift.
 */
const hintFamilyCte = (): SQL =>
  sql`hint_family(hint, decision_types) AS (VALUES ${sql.join(
    CITATION_DECISION_TYPE_HINTS.map(
      (hint) =>
        sql`(${hint}::varchar, ${decisionTypeArray(
          CITATION_DECISION_TYPE_HINT_FAMILIES[hint],
        )})`,
    ),
    sql`, `,
  )})`;

/** What one statement settled, in the terms the runner reports. */
export type CitationResolutionCounts = {
  /** Rows the batch examined. Zero means the scan reached the end. */
  scanned: number;
  /** Rows linked to exactly one decision, whichever rule drew the edge. */
  resolved: number;
  /**
   * `resolved` split by the rule that decided each row. Total over the rule
   * list, so a rule added without a counter fails typecheck, and reported
   * apart so a rule that starts firing unexpectedly is visible in the walk's
   * telemetry rather than folded into the ordinary count.
   */
  resolvedByRule: Record<CitationResolutionRule, number>;
  /** Rows with no surviving candidate. A later decision can revive them. */
  unmatched: number;
  /** Rows with more than one surviving candidate; left unlinked on purpose. */
  ambiguous: number;
  /**
   * Unmatched rows that had a key-, time- and self-valid candidate in a
   * jurisdiction the citing jurisdiction does not declare it can reach.
   *
   * The measurement the cross-border question needs: whether Czech decisions
   * really do cite Slovak ones under the shared pre-1993 docket grammar is a
   * question about data, and this is the count that answers it without any
   * edge being written on a guess.
   */
  jurisdictionBlocked: number;
  /**
   * Rows whose citing decision belongs to a jurisdiction with no declared
   * resolution policy. They are passed over rather than resolved against a
   * default: a wrong link is unrecoverable, an unexamined row is not. Nonzero
   * here means the corpus holds a jurisdiction the registry does not, which is
   * a defect to fix in the declaration, not in the data.
   */
  undeclaredJurisdiction: number;
};

/**
 * Opaque position in the walk: the last `(citing_decision_id, id)` pair
 * examined. Keyset rather than offset because settled rows leave the
 * predicate, which would make an offset skip unexamined rows. Strict on the
 * pair rather than inclusive on the decision id alone, so a decision whose
 * citations straddle a batch boundary neither loses its tail nor re-serves the
 * rows a passed-over jurisdiction leaves behind.
 *
 * Not `SafeId`s — the pair addresses a position in a scan, never an entity.
 */
export type CitationResolutionCursor = {
  citingDecisionId: string;
  citationId: string;
};

export type CitationResolutionBatch = CitationResolutionCounts & {
  /** Where to continue; null when the batch reached the end of the walk. */
  cursor: CitationResolutionCursor | null;
};

export type ResolveCitationBatchOptions = {
  limit: number;
  /** Cursor from the previous batch; null starts at the beginning. */
  after: CitationResolutionCursor | null;
};

const toCount = (value: unknown): number => {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
};

/**
 * `execute` yields the rows directly on the server driver and wraps them in
 * `{ rows }` under pglite. Reading only one shape silently returns zero
 * counts on the other — the statement still runs, so the miscount is
 * invisible until someone trusts the number.
 */
const executedRows = (result: unknown): unknown[] => {
  if (Array.isArray(result)) {
    return result;
  }
  if (isRecord(result) && Array.isArray(result["rows"])) {
    return result["rows"];
  }
  return [];
};

const firstRow = (result: unknown): unknown => {
  if (Array.isArray(result)) {
    return result.at(0);
  }
  if (isRecord(result) && Array.isArray(result["rows"])) {
    return result["rows"].at(0);
  }
  return undefined;
};

/**
 * The key every writer of the citation graph serializes on.
 *
 * Read Committed is not enough here, and the anomaly is not obvious. A batch
 * of the standing walk snapshots a citation as pending; ingestion then commits
 * a decision that matches it and announces the arrival, sees the row still
 * pending in its own snapshot, and correctly concludes there is nothing to
 * reopen; the older batch then commits `unmatched`. The row is terminal, the
 * decision that answers it is stored, and nothing will ever put the two
 * together again.
 *
 * So the walk and the ingestion path take the same transaction-scoped advisory
 * lock — the walk conditionally, because a held walk is a reason to come back
 * later rather than to wait, and ingestion unconditionally, because its work is
 * bounded and must not be dropped. One key, so there is no lock order to get
 * wrong.
 */
const CITATION_GRAPH_LOCK = sql`hashtext('case_law'), hashtext('citation_resolution_walk')`;

/**
 * Serialize this transaction's citation-graph writes against the standing
 * walk. Taken inside every helper that mutates the graph rather than left to
 * call sites: a caller that forgot would reintroduce exactly the interleaving
 * above, and nothing about the resulting rows would look wrong.
 *
 * Re-entrant within a transaction, so a path that reopens and then resolves
 * pays one wait, not two.
 */
export const lockCitationGraph = async (
  tx: CitationResolutionTx,
): Promise<void> => {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(${CITATION_GRAPH_LOCK})`);
};

/** The SQL column name a rule's counter is read from: `unique-key` → `by_rule_unique_key`. */
const ruleCountColumn = (rule: CitationResolutionRule): string =>
  `by_rule_${rule.replaceAll("-", "_")}`;

const EMPTY_COUNTS: CitationResolutionCounts = {
  scanned: 0,
  resolved: 0,
  resolvedByRule: countsByRule(() => 0),
  unmatched: 0,
  ambiguous: 0,
  jurisdictionBlocked: 0,
  undeclaredJurisdiction: 0,
};

const jurisdictionArray = (
  jurisdictions: readonly CaseLawJurisdiction[],
): SQL =>
  sql`ARRAY[${sql.join(
    jurisdictions.map((jurisdiction) => sql`${jurisdiction}`),
    sql`, `,
  )}]::varchar[]`;

/**
 * The declared reach of every jurisdiction as `(citing, allowed[])` rows.
 *
 * The whole map travels with the statement rather than one row's entry,
 * because a batch spans jurisdictions and each row picks up its own reach by
 * joining on its citing decision's country. Built per call: it is five rows of
 * constants, and caching it would only add a second place for the policy to be
 * stale.
 */
const policyCte = (): SQL =>
  sql`policy(citing_country, resolves_to) AS (VALUES ${sql.join(
    citationResolutionPolicyRows().map(
      ({ jurisdiction, resolvesTo }) =>
        sql`(${jurisdiction}::varchar, ${jurisdictionArray(resolvesTo)})`,
    ),
    sql`, `,
  )})`;

type CitationMatchingHoldersSqlOptions = {
  holder: SQL;
  citationKey: SQL;
  identifierType: SQL;
  normalizedIdentifierValue: SQL;
  citingDecisionId: SQL;
  citingDate: SQL;
  citingLanguage: SQL;
  jurisdictionPredicate: SQL;
  limit: number;
};

/**
 * Holders of one citation identity through two independently indexed paths.
 *
 * Keeping the canonical-identifier and legacy case-number bridges as UNION
 * branches is load-bearing. Combining them with OR lets PostgreSQL choose a
 * corpus scan for each citation. The caller supplies only the jurisdiction
 * predicate, so allowed-candidate and blocked-candidate diagnostics cannot
 * drift into different identity matching logic.
 */
const citationMatchingHoldersSql = ({
  holder,
  citationKey,
  identifierType,
  normalizedIdentifierValue,
  citingDecisionId,
  citingDate,
  citingLanguage,
  jurisdictionPredicate,
  limit,
}: CitationMatchingHoldersSqlOptions): SQL => sql`
  SELECT DISTINCT ON (candidate.work_key)
         candidate.id,
         candidate.court,
         candidate.decision_type,
         candidate.ecli,
         candidate.decision_date
  FROM (
    SELECT ${holder}.id,
           ${holder}.court,
           ${holder}.decision_type,
           ${holder}.ecli,
           ${holder}.decision_date,
           ${holder}.language,
           CASE
             WHEN ${holder}.language_group_key IS NULL
               THEN 'decision:' || ${holder}.id::text
             ELSE 'group:' || ${holder}.language_group_key
           END AS work_key
      FROM ${caseLawDecisionIdentifiers} identifier
      JOIN ${caseLawDecisions} ${holder}
        ON ${holder}.id = identifier.decision_id
     WHERE identifier.type = coalesce(${identifierType}, 'case-number')
       AND identifier.normalized_value = coalesce(${normalizedIdentifierValue}, ${citationKey})
       AND ${jurisdictionPredicate}
       AND ${holder}.id <> ${citingDecisionId}
       AND (
             ${holder}.decision_date IS NULL
          OR ${citingDate} IS NULL
          OR ${citingDate} >= ${holder}.decision_date
           )
    UNION ALL
    SELECT ${holder}.id,
           ${holder}.court,
           ${holder}.decision_type,
           ${holder}.ecli,
           ${holder}.decision_date,
           ${holder}.language,
           CASE
             WHEN ${holder}.language_group_key IS NULL
               THEN 'decision:' || ${holder}.id::text
             ELSE 'group:' || ${holder}.language_group_key
           END AS work_key
      FROM ${caseLawDecisions} ${holder}
     WHERE (${identifierType} IS NULL OR ${identifierType} = 'case-number')
       AND ${holder}.citation_key = ${citationKey}
       AND ${jurisdictionPredicate}
       AND ${holder}.id <> ${citingDecisionId}
       AND (
             ${holder}.decision_date IS NULL
          OR ${citingDate} IS NULL
          OR ${citingDate} >= ${holder}.decision_date
           )
       AND NOT EXISTS (
         SELECT 1
         FROM ${caseLawDecisionIdentifiers} existing_identifier
         WHERE existing_identifier.decision_id = ${holder}.id
           AND existing_identifier.type = 'case-number'
           AND existing_identifier.normalized_value = ${citationKey}
       )
  ) candidate
  -- Language manifestations are one judgment, not competing decisions.
  -- Keep one representative per group and prefer the language of the citing
  -- judgment so an inline link opens the wording its reader can use directly.
  ORDER BY candidate.work_key,
           (candidate.language = ${citingLanguage}) DESC,
           candidate.language,
           candidate.id
  LIMIT ${limit}`;

/**
 * The doctrine as CTEs over a `batch` of citations: what each one's
 * candidates are and what the rules make of them, ending in `classified`.
 * `batch` supplies the citation's identity columns and its citing decision's
 * country, date and language.
 */
const classificationCtes = (batch: SQL): SQL => sql`
  ${policyCte()},
  ${hintFamilyCte()},
  batch AS (${batch}),
  candidates AS (
    SELECT b.id,
           b.citing_decision_id,
           pol.resolves_to,
           m.n,
           m.sole_id,
           m.merits_id,
           m.hinted_id,
           m.court_id,
           m.sheet_id,
           m.date_id,
           j.blocked,
           -- The text named the sheet the decision sits on, and exactly one
           -- candidate answers to it. The sheet is the last segment of the
           -- decision's ECLI, so this is the decision's own published
           -- identity rather than a word about it, and it is asked before
           -- every hint. Bounded like the rules below: a count taken on a
           -- truncated candidate set is a guess.
           (
                 m.n > 1
             AND m.n < ${CITATION_CANDIDATE_SCAN_CAP}
             AND b.cited_sheet_number IS NOT NULL
             AND m.sheet_n = 1
           ) AS sheet_matched,
           -- The sentence dated the decision and exactly one candidate
           -- carries that date. Read after the sheet, which is the more
           -- specific of the two.
           (
                 m.n > 1
             AND m.n < ${CITATION_CANDIDATE_SCAN_CAP}
             AND b.cited_decision_date IS NOT NULL
             AND m.date_n = 1
           ) AS date_matched,
           -- The sheet or the date named several candidates, so it narrowed
           -- the file without naming a decision in it. Every rule below
           -- reads a word rather than an identity, and a word that picks a
           -- candidate the date excluded contradicts the citing court: two
           -- decisions of one file issued on one day, one of them a nález,
           -- would otherwise take the link on the one-file rule although the
           -- text dated the citation to neither. The same withholding the
           -- type hint already gets when it names several holders.
           (m.sheet_n > 1 OR m.date_n > 1) AS identity_contradicted,
           -- The text said which decision it meant, and exactly one
           -- candidate is of that type: the link goes there, whatever the
           -- rest of the file looks like. Bounded like the one-file rule,
           -- and for the same reason: a type counted on a truncated set may
           -- have a second holder the scan never reached.
           (
                 m.n > 1
             AND m.n < ${CITATION_CANDIDATE_SCAN_CAP}
             AND m.hinted_n = 1
           ) AS hinted,
           -- The text said which court decided, and exactly one candidate
           -- sits there: regional courts number files independently, so
           -- the court is what makes such a docket number a name. Same
           -- bound as the type rule, and a type hint that already singled
           -- out a holder takes precedence, since it is the more specific
           -- word.
           (
                 m.n > 1
             AND m.n < ${CITATION_CANDIDATE_SCAN_CAP}
             AND m.hinted_n <> 1
             AND m.court_n = 1
           ) AS court_hinted,
           -- The one-file rule, as a predicate over the bounded candidate
           -- set: one court, exactly one merits decision, every other
           -- candidate a procedural order. The strict upper bound is load
           -- bearing: at the cap the set may be truncated, and a rule judged
           -- on a partial set is a guess. A hint that names several holders
           -- withholds the rule too: the text said "usnesení", so linking
           -- the nález would contradict it. A hint naming none is a word
           -- the corpus cannot use and the structural rule still applies.
           (
                 m.n > 1
             AND m.n < ${CITATION_CANDIDATE_SCAN_CAP}
             AND m.hinted_n <= 1
             AND m.courts = 1
             AND m.merits_n = 1
             AND m.procedural_n = m.n - 1
           ) AS one_file
      FROM batch b
      LEFT JOIN policy pol ON pol.citing_country = b.citing_country
      LEFT JOIN hint_family hf ON hf.hint = b.cited_decision_type_hint
      LEFT JOIN LATERAL (
        SELECT count(*)::int AS n,
               (array_agg(k.id))[1] AS sole_id,
               count(DISTINCT k.court)::int AS courts,
               count(*) FILTER (
                 WHERE lower(k.decision_type) = ANY (hf.decision_types)
               )::int AS hinted_n,
               (array_agg(k.id) FILTER (
                 WHERE lower(k.decision_type) = ANY (hf.decision_types)
               ))[1] AS hinted_id,
               count(*) FILTER (
                 WHERE b.cited_court_hint IS NOT NULL
                   AND ${courtNameKeySql(sql.raw("k.court"))}
                     = ${courtNameKeySql(sql.raw("b.cited_court_hint"))}
               )::int AS court_n,
               (array_agg(k.id) FILTER (
                 WHERE b.cited_court_hint IS NOT NULL
                   AND ${courtNameKeySql(sql.raw("k.court"))}
                     = ${courtNameKeySql(sql.raw("b.cited_court_hint"))}
               ))[1] AS court_id,
               count(*) FILTER (WHERE ${sheetMatchSql}
               )::int AS sheet_n,
               (array_agg(k.id) FILTER (WHERE ${sheetMatchSql}
               ))[1] AS sheet_id,
               count(*) FILTER (
                 WHERE b.cited_decision_date IS NOT NULL
                   AND k.decision_date = b.cited_decision_date
               )::int AS date_n,
               (array_agg(k.id) FILTER (
                 WHERE b.cited_decision_date IS NOT NULL
                   AND k.decision_date = b.cited_decision_date
               ))[1] AS date_id,
               count(*) FILTER (
                 WHERE lower(k.decision_type) = ANY (${decisionTypeArray(MERITS_DECISION_TYPES)})
               )::int AS merits_n,
               (array_agg(k.id) FILTER (
                 WHERE lower(k.decision_type) = ANY (${decisionTypeArray(MERITS_DECISION_TYPES)})
               ))[1] AS merits_id,
               count(*) FILTER (
                 WHERE lower(k.decision_type) = ANY (${decisionTypeArray(PROCEDURAL_DECISION_TYPES)})
               )::int AS procedural_n
          FROM (
            ${citationMatchingHoldersSql({
              holder: sql.raw("cited"),
              citationKey: sql.raw("b.citation_key"),
              identifierType: sql.raw("b.identifier_type"),
              normalizedIdentifierValue: sql.raw(
                "b.normalized_identifier_value",
              ),
              citingDecisionId: sql.raw("b.citing_decision_id"),
              citingDate: sql.raw("b.citing_date"),
              citingLanguage: sql.raw("b.citing_language"),
              jurisdictionPredicate: sql`cited.country = ANY (pol.resolves_to)`,
              limit: CITATION_CANDIDATE_SCAN_CAP,
            })}
          ) k
      ) m ON true
      LEFT JOIN LATERAL (
        SELECT 1 AS blocked
          FROM (
            ${citationMatchingHoldersSql({
              holder: sql.raw("other"),
              citationKey: sql.raw("b.citation_key"),
              identifierType: sql.raw("b.identifier_type"),
              normalizedIdentifierValue: sql.raw(
                "b.normalized_identifier_value",
              ),
              citingDecisionId: sql.raw("b.citing_decision_id"),
              citingDate: sql.raw("b.citing_date"),
              citingLanguage: sql.raw("b.citing_language"),
              jurisdictionPredicate: sql`NOT (other.country = ANY (pol.resolves_to))`,
              limit: 1,
            })}
          ) blocked_candidate
      ) j ON true
  ),
  classified AS (
    -- Target and status come from one CASE chain each, in the same order, so
    -- a resolved row always carries its target and an unresolved one never
    -- carries a stale target from an earlier attempt.
    SELECT c.id,
           c.citing_decision_id,
           c.resolves_to,
           c.blocked,
           CASE
             WHEN c.n = 1 THEN c.sole_id
             WHEN c.sheet_matched THEN c.sheet_id
             WHEN c.date_matched THEN c.date_id
             WHEN c.identity_contradicted THEN NULL
             WHEN c.hinted THEN c.hinted_id
             WHEN c.court_hinted THEN c.court_id
             WHEN c.one_file THEN c.merits_id
           END AS decision_id,
           -- The rule is the same chain a third time: a resolved row names
           -- the arm that drew its edge, an unresolved row names none.
           CASE
             WHEN c.n = 1 THEN ${CITATION_RESOLUTION_RULE.UNIQUE_KEY}::text
             WHEN c.sheet_matched
               THEN ${CITATION_RESOLUTION_RULE.SHEET_NUMBER}::text
             WHEN c.date_matched
               THEN ${CITATION_RESOLUTION_RULE.DECISION_DATE}::text
             WHEN c.identity_contradicted THEN NULL
             WHEN c.hinted THEN ${CITATION_RESOLUTION_RULE.TYPE_HINT}::text
             WHEN c.court_hinted
               THEN ${CITATION_RESOLUTION_RULE.COURT_HINT}::text
             WHEN c.one_file
               THEN ${CITATION_RESOLUTION_RULE.ONE_FILE_MERITS}::text
           END AS rule_id,
           CASE
             WHEN c.n = 1 OR c.sheet_matched OR c.date_matched
               THEN ${CITATION_RESOLUTION_STATUS.RESOLVED}::text
             WHEN c.identity_contradicted
               THEN ${CITATION_RESOLUTION_STATUS.AMBIGUOUS}::text
             WHEN c.hinted OR c.court_hinted OR c.one_file
               THEN ${CITATION_RESOLUTION_STATUS.RESOLVED}::text
             WHEN c.n > 1 THEN ${CITATION_RESOLUTION_STATUS.AMBIGUOUS}::text
             ELSE ${CITATION_RESOLUTION_STATUS.UNMATCHED}::text
           END AS status
      FROM candidates c
  )`;

/**
 * The one statement. `selection` names which pending rows this call settles;
 * everything after it is the doctrine, shared so the walk, the ingest-time
 * pass and the classification of rows about to be written cannot drift into
 * different definitions of an honest link.
 *
 * `cited_decision_id` is written from the same CASE that writes the status, so
 * a resolved row always carries its target and an unresolved one never carries
 * a stale target from an earlier attempt.
 */
const resolutionStatement = (selection: SQL): SQL => sql`
  WITH ${classificationCtes(sql`
    SELECT c.id,
           c.citation_key,
           c.identifier_type,
           c.normalized_identifier_value,
           c.citing_decision_id,
           c.cited_decision_type_hint,
           c.cited_court_hint,
           c.cited_sheet_number,
           c.cited_decision_date,
           citing.country AS citing_country,
           citing.decision_date AS citing_date,
           citing.language AS citing_language
      FROM ${caseLawCitations} c
      JOIN ${caseLawDecisions} citing ON citing.id = c.citing_decision_id
     WHERE ${unsettledCitationSql({
       resolutionStatus: sql.raw("c.resolution_status"),
       citedDecisionId: sql.raw("c.cited_decision_id"),
       citationKey: sql.raw("c.citation_key"),
     })}
       ${selection}
  `)},
  updated AS (
    UPDATE ${caseLawCitations} target
       SET cited_decision_id = cls.decision_id,
           resolution_status = cls.status,
           resolution_rule_id = cls.rule_id,
           resolution_attempted_at = now()
      FROM classified cls
     WHERE target.id = cls.id
       AND cls.resolves_to IS NOT NULL
    RETURNING target.resolution_status AS status,
              target.resolution_rule_id AS rule_id,
              cls.blocked
  )
  SELECT (SELECT count(*)::int FROM batch) AS scanned,
         (SELECT count(*)::int FROM classified WHERE resolves_to IS NULL)
           AS undeclared_jurisdiction,
         (SELECT citing_decision_id::text
            FROM batch ORDER BY citing_decision_id DESC, id DESC LIMIT 1)
           AS last_citing_decision_id,
         (SELECT id::text
            FROM batch ORDER BY citing_decision_id DESC, id DESC LIMIT 1)
           AS last_citation_id,
         count(*) FILTER (
           WHERE u.status = ${CITATION_RESOLUTION_STATUS.RESOLVED}
         )::int AS resolved,
         ${sql.join(
           CITATION_RESOLUTION_RULES.map(
             (rule) =>
               sql`count(*) FILTER (
                 WHERE u.status = ${CITATION_RESOLUTION_STATUS.RESOLVED}
                   AND u.rule_id = ${rule}
               )::int AS ${sql.raw(ruleCountColumn(rule))}`,
           ),
           sql`, `,
         )},
         count(*) FILTER (
           WHERE u.status = ${CITATION_RESOLUTION_STATUS.UNMATCHED}
         )::int AS unmatched,
         count(*) FILTER (
           WHERE u.status = ${CITATION_RESOLUTION_STATUS.AMBIGUOUS}
         )::int AS ambiguous,
         count(*) FILTER (
           WHERE u.status = ${CITATION_RESOLUTION_STATUS.UNMATCHED}
             AND u.blocked IS NOT NULL
         )::int AS jurisdiction_blocked
    FROM updated u
`;

const countsOf = (row: Record<string, unknown>): CitationResolutionCounts => ({
  scanned: toCount(row["scanned"]),
  resolved: toCount(row["resolved"]),
  resolvedByRule: countsByRule((rule) => toCount(row[ruleCountColumn(rule)])),
  unmatched: toCount(row["unmatched"]),
  ambiguous: toCount(row["ambiguous"]),
  jurisdictionBlocked: toCount(row["jurisdiction_blocked"]),
  undeclaredJurisdiction: toCount(row["undeclared_jurisdiction"]),
});

/**
 * Settle one bounded slice of the pending set, walking by citing decision.
 *
 * The batch is ordered and limited inside the statement, so the number of
 * candidate lookups is `limit`, whatever the corpus holds.
 */
const resolveCitationBatchIn = async (
  tx: CitationResolutionTx,
  { limit, after }: ResolveCitationBatchOptions,
): Promise<CitationResolutionBatch> => {
  // audit: skip — derived citation graph, not a user action
  const result: unknown = await tx.execute(
    resolutionStatement(sql`
      ${
        after === null
          ? sql``
          : sql`AND (c.citing_decision_id, c.id) > (${after.citingDecisionId}::uuid, ${after.citationId}::uuid)`
      }
      ORDER BY c.citing_decision_id, c.id
      LIMIT ${limit}
    `),
  );

  const row: unknown = firstRow(result);
  if (!isRecord(row)) {
    return { ...EMPTY_COUNTS, cursor: null };
  }
  const citingDecisionId = row["last_citing_decision_id"];
  const citationId = row["last_citation_id"];
  return {
    ...countsOf(row),
    cursor:
      typeof citingDecisionId === "string" && typeof citationId === "string"
        ? { citingDecisionId, citationId }
        : null,
  };
};

/**
 * Settle one batch from an explicit position, waiting for the walk rather than
 * skipping it.
 *
 * Every exported entry point that touches the graph takes the lock, including
 * this one: an unlocked variant sitting beside the locked ones is the call site
 * that reintroduces the interleaving, and the rows it produces look correct.
 * The daemon uses `tryResolveCitationBatch`, which declines instead of waiting
 * because a held walk is a reason to come back later.
 */
export const resolveCitationBatch = async (
  scopedDb: ScopedDb,
  options: ResolveCitationBatchOptions,
): Promise<CitationResolutionBatch> =>
  await scopedDb(async (tx) => {
    await lockCitationGraph(tx);
    return await resolveCitationBatchIn(tx, options);
  });

/**
 * Settle one batch, or report that another writer is already walking.
 *
 * The lock, the cursor read, the batch and the cursor write are one
 * transaction, and that is the whole point. Overlapping processes are the
 * normal case during a rolling deployment; with the position read and written
 * outside the lock, two replicas can persist out of order, or one that found
 * the walk held can overwrite the holder's new position with the value it
 * loaded at start-up. Neither loses work — the walk wraps, and settled rows
 * leave the predicate — but both make a restart resume somewhere arbitrary.
 * Holding the lock across the read-modify-write removes the race rather than
 * documenting it.
 *
 * A batch that finds nothing writes the wrap back to the beginning, so a task
 * that stops right after draining does not resume at the far end of a queue
 * that has since been refilled behind it.
 */
export const tryResolveCitationBatch = async (
  scopedDb: ScopedDb,
  { limit }: { limit: number },
): Promise<CitationResolutionBatch | null> =>
  await scopedDb(async (tx) => {
    const lockResult: unknown = await tx.execute(
      sql`SELECT pg_try_advisory_xact_lock(${CITATION_GRAPH_LOCK}) AS locked`,
    );
    const lockRow: unknown = firstRow(lockResult);
    if (!isRecord(lockRow) || lockRow["locked"] !== true) {
      return null;
    }

    const after = await readCitationResolutionCursor(tx);
    const batch = await resolveCitationBatchIn(tx, { limit, after });
    await writeCitationResolutionCursor(
      tx,
      batch.scanned === 0 ? null : batch.cursor,
    );
    return batch;
  });

/**
 * Read the persisted position. Inside the walk's transaction, never on its
 * own: a position read outside the lock is a position another replica may
 * already have moved.
 */
const readCitationResolutionCursor = async (
  tx: CitationResolutionTx,
): Promise<CitationResolutionCursor | null> => {
  const result: unknown = await tx.execute(sql`
    SELECT cursor_citing_decision_id::text AS citing_decision_id,
           cursor_citation_id::text AS citation_id
      FROM ${caseLawCitationResolutionProgress}
     WHERE scope = ${CITATION_RESOLUTION_SCOPE.GLOBAL}
  `);
  const row: unknown = firstRow(result);
  if (!isRecord(row)) {
    return null;
  }
  const citingDecisionId = row["citing_decision_id"];
  const citationId = row["citation_id"];
  // The pair is enforced whole by a check constraint; both are read anyway
  // because a half-cursor would silently restart the walk mid-corpus.
  return typeof citingDecisionId === "string" && typeof citationId === "string"
    ? { citingDecisionId, citationId }
    : null;
};

const writeCitationResolutionCursor = async (
  tx: CitationResolutionTx,
  cursor: CitationResolutionCursor | null,
): Promise<void> => {
  // Written as SQL rather than through the query builder: the cursor travels
  // as opaque text because it addresses a position in a scan, and the columns
  // are branded ids. Re-branding here would claim an entity identity the walk
  // never established; the database's own `::uuid` cast is the check that
  // matters, and it rejects anything that is not one.
  // audit: skip — background walk bookkeeping, not a user action
  await tx.execute(sql`
    INSERT INTO ${caseLawCitationResolutionProgress}
      (scope, cursor_citing_decision_id, cursor_citation_id, updated_at)
    VALUES (
      ${CITATION_RESOLUTION_SCOPE.GLOBAL},
      ${cursor?.citingDecisionId ?? null}::uuid,
      ${cursor?.citationId ?? null}::uuid,
      now()
    )
    ON CONFLICT (scope) DO UPDATE
      SET cursor_citing_decision_id = EXCLUDED.cursor_citing_decision_id,
          cursor_citation_id = EXCLUDED.cursor_citation_id,
          updated_at = EXCLUDED.updated_at
  `);
};

/**
 * Settle the citations of one decision, in the transaction that just wrote
 * them.
 *
 * The pipeline already holds the citing decision's jurisdiction and date, and
 * the rows are in cache; resolving here costs one indexed lookup per citation
 * against the S3 fetch and parse the same page already paid for. Without it
 * every newly ingested citation waits for the standing walk to come round,
 * which on a corpus this size is the difference between a citator that is
 * current and one that trails the crawl.
 *
 * Bounded by the decision's own citation count, which the extractor caps.
 */
export const resolveCitationsForDecision = async (
  tx: CitationResolutionTx,
  decisionId: SafeId<"caseLawDecision">,
): Promise<CitationResolutionCounts> => {
  await lockCitationGraph(tx);
  // audit: skip — derived citation graph, not a user action
  const result: unknown = await tx.execute(
    resolutionStatement(sql`AND c.citing_decision_id = ${decisionId}::uuid`),
  );
  const row: unknown = firstRow(result);
  return isRecord(row) ? countsOf(row) : EMPTY_COUNTS;
};

/** A citation about to be written, in the columns classification reads. */
export type UnwrittenCitation = {
  id: SafeId<"caseLawCitation">;
  citationKey: string | null;
  identifierType: string | null;
  normalizedIdentifierValue: string | null;
  citedDecisionTypeHint: string | null;
  citedCourtHint: string | null;
  citedSheetNumber: string | null;
  citedDecisionDate: string | null;
};

/** What the resolver decides for a citation, to be written with the row. */
export type CitationResolution = {
  citedDecisionId: SafeId<"caseLawDecision"> | null;
  resolutionStatus: CitationResolutionStatus;
  resolutionRuleId: CitationResolutionRule | null;
};

const isCitationResolutionStatus = (
  value: unknown,
): value is CitationResolutionStatus =>
  typeof value === "string" &&
  CITATION_RESOLUTION_STATUSES.some((status) => status === value);

const isCitationResolutionRule = (
  value: unknown,
): value is CitationResolutionRule =>
  typeof value === "string" &&
  CITATION_RESOLUTION_RULES.some((rule) => rule === value);

/**
 * Settle citations before they are written, so each row is inserted with its
 * outcome instead of inserted pending and then updated.
 *
 * The same doctrine as the walk, over the rows in hand rather than rows read
 * back: matching reads only the decision graph, never the citation table, so
 * a row's absence from it changes nothing. The citing decision must already
 * be written in this transaction; its country, date and language are read
 * from it exactly as the walk reads them.
 *
 * A row the map leaves out is written pending, as the walk would have left
 * it: its key does not canonicalize, or its citing jurisdiction declares no
 * resolution policy.
 */
export const classifyCitationsBeforeWrite = async (
  tx: CitationResolutionTx,
  {
    citingDecisionId,
    citations,
  }: {
    citingDecisionId: SafeId<"caseLawDecision">;
    citations: readonly UnwrittenCitation[];
  },
): Promise<Map<string, CitationResolution>> => {
  const resolvable = citations.filter(
    (citation) => citation.citationKey !== null,
  );
  if (resolvable.length === 0) {
    return new Map();
  }
  await lockCitationGraph(tx);
  // One jsonb parameter rather than a VALUES list, so the statement's text is
  // the same whatever the decision's citation count and one prepared plan
  // serves every call.
  const rows = JSON.stringify(
    resolvable.map((citation) => ({
      id: citation.id,
      citation_key: citation.citationKey,
      identifier_type: citation.identifierType,
      normalized_identifier_value: citation.normalizedIdentifierValue,
      cited_decision_type_hint: citation.citedDecisionTypeHint,
      cited_court_hint: citation.citedCourtHint,
      cited_sheet_number: citation.citedSheetNumber,
      cited_decision_date: citation.citedDecisionDate,
    })),
  );
  const result: unknown = await tx.execute(sql`
    WITH ${classificationCtes(sql`
      SELECT c.id,
             c.citation_key,
             c.identifier_type,
             c.normalized_identifier_value,
             citing.id AS citing_decision_id,
             c.cited_decision_type_hint,
             c.cited_court_hint,
             c.cited_sheet_number,
             c.cited_decision_date,
             citing.country AS citing_country,
             citing.decision_date AS citing_date,
             citing.language AS citing_language
        FROM jsonb_to_recordset(${rows}::text::jsonb) AS c(
               id uuid,
               citation_key varchar,
               identifier_type varchar,
               normalized_identifier_value varchar,
               cited_decision_type_hint varchar,
               cited_court_hint varchar,
               cited_sheet_number varchar,
               cited_decision_date date
             )
        JOIN ${caseLawDecisions} citing ON citing.id = ${citingDecisionId}::uuid
    `)}
    SELECT cls.id::text AS id,
           cls.decision_id::text AS decision_id,
           cls.rule_id,
           cls.status
      FROM classified cls
     WHERE cls.resolves_to IS NOT NULL
  `);
  const resolutions = new Map<string, CitationResolution>();
  for (const row of executedRows(result)) {
    if (!isRecord(row) || typeof row["id"] !== "string") {
      return panic("citation classification returned a row without an id");
    }
    const status = row["status"];
    if (!isCitationResolutionStatus(status)) {
      return panic(`citation classification returned status ${String(status)}`);
    }
    const ruleId = row["rule_id"];
    const decisionId = row["decision_id"];
    resolutions.set(row["id"], {
      citedDecisionId:
        typeof decisionId === "string"
          ? brandPersistedCaseLawDecisionId(decisionId)
          : null,
      resolutionStatus: status,
      resolutionRuleId: isCitationResolutionRule(ruleId) ? ruleId : null,
    });
  }
  return resolutions;
};

export type ReopenCitationsForKeyOptions = {
  /** The key the arriving decision canonicalizes to. */
  citationKey: string;
  /** The arriving decision, excluded from its own re-adjudication. */
  decisionId: SafeId<"caseLawDecision">;
  /** Its jurisdiction, which decides whose citations it can newly answer. */
  jurisdiction: CaseLawJurisdiction;
  /** Its date; a citation older than the decision was never about it. */
  decisionDate: string | null;
};

/**
 * Put back for another attempt every citation a newly stored decision changes
 * the answer for.
 *
 * Both directions matter, and only one of them is obvious. A decision arriving
 * under a key that nothing matched turns `unmatched` rows into resolvable ones
 * — that is the citator catching up with the crawl. The other direction is the
 * one that quietly rots a graph: a second decision under a key that already had
 * exactly one holder makes every edge drawn to the first one ambiguous, and an
 * edge that was honest when it was written is not honest now. Leaving it is a
 * wrong number in the authority ranking that nothing ever revisits.
 *
 * Both are bounded. The first is driven by the partial index on unmatched
 * keys; the second reaches only citations already pointing at a decision that
 * shares the arriving key, through the cited-decision index.
 *
 * Reopening rather than re-deciding on the spot is deliberate: the resolver
 * owns what an honest link is, and this only decides which rows must be asked
 * again. The ambiguity tier reopens the same way.
 */
export const reopenCitationsForDecisionKey = async (
  tx: CitationResolutionTx,
  {
    citationKey,
    decisionId,
    jurisdiction,
    decisionDate,
  }: ReopenCitationsForKeyOptions,
): Promise<number> => {
  await lockCitationGraph(tx);
  const reachedFrom = sql`(
    SELECT pol.citing_country
      FROM (VALUES ${sql.join(
        citationResolutionPolicyRows().map(
          ({ jurisdiction: citing, resolvesTo }) =>
            sql`(${citing}::varchar, ${jurisdictionArray(resolvesTo)})`,
        ),
        sql`, `,
      )}) AS pol(citing_country, resolves_to)
     WHERE ${jurisdiction}::varchar = ANY (pol.resolves_to)
  )`;

  // A citation is only affected if its own jurisdiction declares it can reach
  // the arriving decision's, and if the decision is not newer than it.
  const affects = sql`
    citing.country IN ${reachedFrom}
    AND (
          citing.decision_date IS NULL
       OR ${decisionDate}::date IS NULL
       OR citing.decision_date >= ${decisionDate}::date
        )
  `;

  // Two data-modifying CTEs over one table are only safe while no row can
  // match both, and none can: `revived` reads the two negative outcomes and
  // `contested` reads `resolved` ones. Postgres does not define which write
  // wins when a statement updates a row twice, so the disjointness is load
  // bearing, not incidental.
  // audit: skip — derived citation graph, not a user action
  const result: unknown = await tx.execute(sql`
    WITH revived AS (
      UPDATE ${caseLawCitations} c
         SET resolution_status = ${CITATION_RESOLUTION_STATUS.PENDING},
             resolution_rule_id = NULL
        FROM ${caseLawDecisions} citing
       WHERE citing.id = c.citing_decision_id
         AND c.citation_key = ${citationKey}
         AND ${citationReopenableByKeySql(sql.raw("c.resolution_status"))}
         AND ${affects}
      RETURNING c.id
    ),
    contested AS (
      UPDATE ${caseLawCitations} c
         SET resolution_status = ${CITATION_RESOLUTION_STATUS.PENDING},
             cited_decision_id = NULL,
             resolution_rule_id = NULL
        FROM ${caseLawDecisions} citing, ${caseLawDecisions} cited
       WHERE citing.id = c.citing_decision_id
         AND cited.id = c.cited_decision_id
         AND cited.id <> ${decisionId}::uuid
         AND cited.citation_key = ${citationKey}
         AND c.resolution_status = ${CITATION_RESOLUTION_STATUS.RESOLVED}
         AND ${affects}
      RETURNING c.id
    )
    SELECT (SELECT count(*)::int FROM revived)
         + (SELECT count(*)::int FROM contested) AS reopened
  `);

  const row: unknown = firstRow(result);
  return isRecord(row) ? toCount(row["reopened"]) : 0;
};

type NormalizedDecisionIdentifier = {
  type: DecisionIdentifierType;
  normalizedValue: string;
};

type ReopenCitationsForDecisionIdentifiersOptions = {
  identifiers: readonly NormalizedDecisionIdentifier[];
  decisionId: SafeId<"caseLawDecision">;
  jurisdiction: CaseLawJurisdiction;
  decisionDate: string | null;
};

/** Reopen typed citations whose candidate set changed with one decision. */
export const reopenCitationsForDecisionIdentifiers = async (
  tx: CitationResolutionTx,
  {
    identifiers,
    decisionId,
    jurisdiction,
    decisionDate,
  }: ReopenCitationsForDecisionIdentifiersOptions,
): Promise<number> => {
  if (identifiers.length === 0) {
    return 0;
  }
  await lockCitationGraph(tx);
  const identifierRows = sql.join(
    identifiers.map(
      (identifier) =>
        sql`(${identifier.type}::varchar, ${identifier.normalizedValue}::varchar)`,
    ),
    sql`, `,
  );
  const reachedFrom = sql`(
    SELECT pol.citing_country
      FROM (VALUES ${sql.join(
        citationResolutionPolicyRows().map(
          ({ jurisdiction: citing, resolvesTo }) =>
            sql`(${citing}::varchar, ${jurisdictionArray(resolvesTo)})`,
        ),
        sql`, `,
      )}) AS pol(citing_country, resolves_to)
     WHERE ${jurisdiction}::varchar = ANY (pol.resolves_to)
  )`;

  const result: unknown = await tx.execute(sql`
    WITH arriving(type, normalized_value) AS (VALUES ${identifierRows}),
    revived AS (
      UPDATE ${caseLawCitations} citation
         SET resolution_status = ${CITATION_RESOLUTION_STATUS.PENDING},
             resolution_rule_id = NULL
        FROM ${caseLawDecisions} citing
       WHERE citing.id = citation.citing_decision_id
         AND EXISTS (
           SELECT 1
           FROM arriving
           WHERE arriving.type = coalesce(citation.identifier_type, 'case-number')
             AND arriving.normalized_value = coalesce(
               citation.normalized_identifier_value,
               citation.citation_key
             )
         )
         AND ${citationReopenableByKeySql(sql.raw("citation.resolution_status"))}
         AND citing.country IN ${reachedFrom}
         AND (
               citing.decision_date IS NULL
            OR ${decisionDate}::date IS NULL
            OR citing.decision_date >= ${decisionDate}::date
             )
      RETURNING citation.id
    ),
    contested AS (
      UPDATE ${caseLawCitations} citation
         SET resolution_status = ${CITATION_RESOLUTION_STATUS.PENDING},
             cited_decision_id = NULL,
             resolution_rule_id = NULL
        FROM ${caseLawDecisions} citing, ${caseLawDecisions} cited
       WHERE citing.id = citation.citing_decision_id
         AND cited.id = citation.cited_decision_id
         AND cited.id <> ${decisionId}::uuid
         AND EXISTS (
           SELECT 1
           FROM arriving
           JOIN ${caseLawDecisionIdentifiers} cited_identifier
             ON cited_identifier.type = arriving.type
            AND cited_identifier.normalized_value = arriving.normalized_value
           WHERE cited_identifier.decision_id = cited.id
         )
         AND citation.resolution_status = ${CITATION_RESOLUTION_STATUS.RESOLVED}
         AND citing.country IN ${reachedFrom}
         AND (
               citing.decision_date IS NULL
            OR ${decisionDate}::date IS NULL
            OR citing.decision_date >= ${decisionDate}::date
             )
      RETURNING citation.id
    )
    SELECT (SELECT count(*)::int FROM revived)
         + (SELECT count(*)::int FROM contested) AS reopened
  `);
  const row: unknown = firstRow(result);
  return isRecord(row) ? toCount(row["reopened"]) : 0;
};

/**
 * Reopen every citation a set of keys can now answer differently.
 *
 * The bulk shape of `reopenCitationsForDecisionKey`, for callers that change
 * many decisions' keys at once — the key backfill writes five thousand per
 * statement, and calling the single-decision path per key would take the graph
 * lock five thousand times.
 *
 * Deliberately more conservative than the single-decision path: it does not
 * know which jurisdiction or date each key arrived under, so it reopens every
 * citation those keys touch and lets the resolver re-decide. Reopening a row
 * that turns out to resolve the same way costs one indexed lookup; failing to
 * reopen one leaves a wrong edge nothing revisits, and the two are not
 * comparable.
 *
 * Both arms matter. A key finding its first holder revives the citations that
 * gave up on it; a key finding a *second* holder retracts the edges drawn to
 * the first, which is the transition a backfill assigning an already-held key
 * creates and the one that leaves an arbitrary authority edge behind.
 */
export const reopenCitationsForKeys = async (
  tx: CitationResolutionTx,
  citationKeys: readonly string[],
): Promise<number> => {
  if (citationKeys.length === 0) {
    return 0;
  }
  await lockCitationGraph(tx);
  const keys = sql`ARRAY[${sql.join(
    citationKeys.map((key) => sql`${key}`),
    sql`, `,
  )}]::varchar[]`;
  // Disjoint arms again: `revived` reads the negative outcomes, `contested`
  // reads `resolved`, and no row can match both.
  // audit: skip — derived citation graph, not a user action
  const result: unknown = await tx.execute(sql`
    WITH revived AS (
      UPDATE ${caseLawCitations} c
         SET resolution_status = ${CITATION_RESOLUTION_STATUS.PENDING},
             resolution_rule_id = NULL
       WHERE c.citation_key = ANY (${keys})
         AND ${citationReopenableByKeySql(sql.raw("c.resolution_status"))}
      RETURNING c.id
    ),
    contested AS (
      UPDATE ${caseLawCitations} c
         SET resolution_status = ${CITATION_RESOLUTION_STATUS.PENDING},
             cited_decision_id = NULL,
             resolution_rule_id = NULL
        FROM ${caseLawDecisions} cited
       WHERE cited.id = c.cited_decision_id
         AND cited.citation_key = ANY (${keys})
         AND c.resolution_status = ${CITATION_RESOLUTION_STATUS.RESOLVED}
      RETURNING c.id
    )
    SELECT (SELECT count(*)::int FROM revived)
         + (SELECT count(*)::int FROM contested) AS reopened
  `);
  const row: unknown = firstRow(result);
  return isRecord(row) ? toCount(row["reopened"]) : 0;
};

/**
 * Retract every edge drawn to a decision whose identity just changed.
 *
 * The complement of `reopenCitationsForDecisionKey`, which deliberately
 * excludes the arriving decision's own links. A refresh that rewrites the case
 * number, the jurisdiction or the date changes what this decision is, and
 * every one of those three fields is a filter in the candidate join — so an
 * edge drawn under the old values was decided against a decision that no
 * longer exists in that form. It is not enough to announce the new key: the
 * old links point here, and nothing else would ever ask about them again.
 *
 * Bounded by the cited-decision index, so the cost is this decision's incoming
 * citations rather than the table.
 */
export const reopenCitationsResolvedTo = async (
  tx: CitationResolutionTx,
  decisionId: SafeId<"caseLawDecision">,
): Promise<number> => {
  await lockCitationGraph(tx);
  // audit: skip — derived citation graph, not a user action
  const result: unknown = await tx.execute(sql`
    WITH retracted AS (
      UPDATE ${caseLawCitations}
         SET resolution_status = ${CITATION_RESOLUTION_STATUS.PENDING}::text,
             cited_decision_id = NULL,
             resolution_rule_id = NULL
       WHERE cited_decision_id = ${decisionId}::uuid
         AND resolution_status = ${CITATION_RESOLUTION_STATUS.RESOLVED}
      RETURNING id
    )
    SELECT count(*)::int AS reopened FROM retracted
  `);
  const row: unknown = firstRow(result);
  return isRecord(row) ? toCount(row["reopened"]) : 0;
};

/**
 * Re-adjudicate every citation a decision *makes*, after its own identity
 * changed.
 *
 * The outgoing direction, and the one that is easiest to forget because the
 * decision is the subject rather than the object. A citing decision's
 * jurisdiction and date are not description: they are the resolver's policy
 * filter and its time filter. Moving the date past a candidate's turns an
 * `unmatched` citation into a resolvable one; moving it back invalidates a
 * `resolved` edge that was honest under the old date. Neither is discoverable
 * from the cited side, and the walk excludes terminal rows, so nothing else
 * would ever ask again.
 *
 * Every non-pending row, not just the negatives: a date moving backwards
 * retracts, a date moving forwards revives, and this cannot tell which without
 * redoing the adjudication that the resolver owns.
 *
 * Bounded by the citing index, so the cost is this decision's own citations.
 */
export const reopenCitationsFrom = async (
  tx: CitationResolutionTx,
  decisionId: SafeId<"caseLawDecision">,
): Promise<number> => {
  await lockCitationGraph(tx);
  // audit: skip — derived citation graph, not a user action
  const result: unknown = await tx.execute(sql`
    WITH requeued AS (
      UPDATE ${caseLawCitations}
         SET resolution_status = ${CITATION_RESOLUTION_STATUS.PENDING}::text,
             cited_decision_id = NULL,
             resolution_rule_id = NULL
       WHERE citing_decision_id = ${decisionId}::uuid
         AND resolution_status <> ${CITATION_RESOLUTION_STATUS.PENDING}
      RETURNING id
    )
    SELECT count(*)::int AS reopened FROM requeued
  `);
  const row: unknown = firstRow(result);
  return isRecord(row) ? toCount(row["reopened"]) : 0;
};

/**
 * Put a named, bounded set of citations back into the pending queue.
 *
 * The generic re-entry path: `reopenCitationsForDecisionKey` is what the
 * ingestion pipeline uses because it knows a key rather than a set of rows,
 * and an adjudication pass over `ambiguous` rows knows the opposite. Both end
 * in the same place, so the queue has one door.
 *
 * Bounded by the caller's list, and the list is the caller's bound to keep;
 * this refuses an unbounded one by construction because it takes ids.
 */
export const reopenCitations = async (
  tx: CitationResolutionTx,
  citationIds: readonly SafeId<"caseLawCitation">[],
): Promise<number> => {
  if (citationIds.length === 0) {
    return 0;
  }
  await lockCitationGraph(tx);
  // audit: skip — derived citation graph, not a user action
  const result: unknown = await tx.execute(sql`
    WITH reopened AS (
      UPDATE ${caseLawCitations}
         SET resolution_status = ${CITATION_RESOLUTION_STATUS.PENDING}::text,
             cited_decision_id = NULL,
             resolution_rule_id = NULL
       WHERE id = ANY (ARRAY[${sql.join(
         citationIds.map((id) => sql`${id}`),
         sql`, `,
       )}]::uuid[])
         AND resolution_status <> ${CITATION_RESOLUTION_STATUS.PENDING}
      RETURNING id
    )
    SELECT count(*)::int AS reopened FROM reopened
  `);
  const row: unknown = firstRow(result);
  return isRecord(row) ? toCount(row["reopened"]) : 0;
};

export type ReadjudicateAmbiguousCitationsOptions = {
  limit: number;
  /** Cursor from the previous batch; null starts at the beginning. */
  after: CitationResolutionCursor | null;
};

export type ReadjudicateAmbiguousCitationsBatch = CitationResolutionCounts & {
  /** Where to continue; null when the batch reached the end of the walk. */
  cursor: CitationResolutionCursor | null;
};

/**
 * Ask the resolver again about one bounded slice of the `ambiguous` rows.
 *
 * The adjudication tier's door into the queue. A new rule changes the answer
 * for rows the walk has already settled, and settled rows leave the walk's
 * predicate, so nothing revisits them unless something puts them back. This
 * reopens a keyset batch of ambiguous rows and resolves them in the same
 * transaction, under the same lock, so the rows never sit pending where the
 * standing walk could race for them.
 *
 * Idempotent: a row the rule cannot decide comes back `ambiguous` with a new
 * attempt time and nothing else changed, so a second pass over the same range
 * finds the same rows and rewrites the same answers.
 */
export const readjudicateAmbiguousCitations = async (
  scopedDb: ScopedDb,
  { limit, after }: ReadjudicateAmbiguousCitationsOptions,
): Promise<ReadjudicateAmbiguousCitationsBatch> =>
  await scopedDb(async (tx) => {
    await lockCitationGraph(tx);
    // audit: skip — derived citation graph, not a user action
    const picked: unknown = await tx.execute(sql`
      WITH slice AS (
        SELECT c.id, c.citing_decision_id
          FROM ${caseLawCitations} c
         WHERE c.resolution_status = ${CITATION_RESOLUTION_STATUS.AMBIGUOUS}
           AND c.citation_key IS NOT NULL
           ${
             after === null
               ? sql``
               : sql`AND (c.citing_decision_id, c.id) > (${after.citingDecisionId}::uuid, ${after.citationId}::uuid)`
           }
         ORDER BY c.citing_decision_id, c.id
         LIMIT ${limit}
      ),
      reopened AS (
        UPDATE ${caseLawCitations} target
           SET resolution_status = ${CITATION_RESOLUTION_STATUS.PENDING}::text,
               resolution_rule_id = NULL
          FROM slice
         WHERE target.id = slice.id
        RETURNING target.id
      )
      SELECT (SELECT count(*)::int FROM reopened) AS reopened,
             (SELECT citing_decision_id::text
                FROM slice ORDER BY citing_decision_id DESC, id DESC LIMIT 1)
               AS last_citing_decision_id,
             (SELECT id::text
                FROM slice ORDER BY citing_decision_id DESC, id DESC LIMIT 1)
               AS last_citation_id,
             (SELECT array_agg(id::text) FROM slice) AS ids
    `);
    const pickedRow: unknown = firstRow(picked);
    if (!isRecord(pickedRow) || !Array.isArray(pickedRow["ids"])) {
      return { ...EMPTY_COUNTS, cursor: null };
    }
    const ids = pickedRow["ids"].filter(
      (id): id is string => typeof id === "string",
    );
    if (ids.length === 0) {
      return { ...EMPTY_COUNTS, cursor: null };
    }
    const citingDecisionId = pickedRow["last_citing_decision_id"];
    const citationId = pickedRow["last_citation_id"];
    const cursor =
      typeof citingDecisionId === "string" && typeof citationId === "string"
        ? { citingDecisionId, citationId }
        : null;

    // audit: skip — derived citation graph, not a user action
    const result: unknown = await tx.execute(
      resolutionStatement(sql`
        AND c.id = ANY (ARRAY[${sql.join(
          ids.map((id) => sql`${id}`),
          sql`, `,
        )}]::uuid[])
      `),
    );
    const row: unknown = firstRow(result);
    return { ...(isRecord(row) ? countsOf(row) : EMPTY_COUNTS), cursor };
  });

/**
 * How much work the walk has left. Read on the summary interval rather than
 * per batch: it is an index-only count over the burn-down index, which shrinks
 * as the walk proceeds but is a full traversal of what remains.
 *
 * Counted over the same predicate the walk selects on, not a narrower one. The
 * idle-contradiction warning compares this number against what a window
 * examined, so a gauge that read zero while the walk still had rows to settle
 * would turn the one signal that catches a wedged walk into noise — and it
 * would do so exactly in the case the second arm of the predicate exists for.
 */
export const countPendingCitations = async (
  scopedDb: ScopedDb,
): Promise<number> =>
  await scopedDb(async (tx) => {
    const result: unknown = await tx.execute(sql`
      SELECT count(*)::int AS pending
        FROM ${caseLawCitations} c
       WHERE ${unsettledCitationSql({
         resolutionStatus: sql.raw("c.resolution_status"),
         citedDecisionId: sql.raw("c.cited_decision_id"),
         citationKey: sql.raw("c.citation_key"),
       })}
    `);
    const row: unknown = firstRow(result);
    return isRecord(row) ? toCount(row["pending"]) : 0;
  });
