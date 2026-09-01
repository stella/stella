/**
 * The statements `normalize-case-numbers.ts` runs, separated from the script
 * that runs them.
 *
 * An operator script is a module with a side effect at the top level, so
 * nothing can import it and nothing in CI ever executes its SQL. A multi-CTE
 * statement assembled by hand in such a file is unreviewable in the only way
 * that counts: a missing comma between two CTEs is a syntax error the database
 * rejects on the first invocation and no test ever sees. Keeping the SQL here,
 * where a database test can execute it, is what closes that gap.
 */

import type { SQL } from "drizzle-orm";
import { sql } from "drizzle-orm";

import {
  CITATION_RESOLUTION_STATUS,
  citationReopenableByKeySql,
} from "@/api/handlers/case-law/citation-resolution-status";

/**
 * Trailing `-<digits>` on a docket that already carries a year — the same
 * shape `splitCaseReference` applies at ingest, expressed in SQL so a batch is
 * one statement. The year is what keeps references that merely end in a number
 * (`0T/42/2019`) from being split.
 *
 * The optional space on either side of the dash mirrors the split's, and has
 * to: rows stored before the ingest read the spaced form carry it in
 * `case_number`, and a pattern the ingest accepts but the backfill does not
 * leaves exactly those rows behind. Group 1 ends on a digit, so the docket
 * this writes back carries no trailing space.
 */
export const SHEET_PATTERN = String.raw`^(.*/\d{2,4}) ?- ?(\d+)$`;

/** How many rows carry a sheet number, and how many of them can be split. */
export const sheetNumberSurveyStatement = (): SQL => sql`
  SELECT
    count(*) FILTER (WHERE source_document_id IS NOT NULL)::int AS ready,
    count(*) FILTER (WHERE source_document_id IS NULL)::int AS blocked
  FROM case_law_decisions
  WHERE case_number ~ ${SHEET_PATTERN}
`;

/**
 * Split one bounded batch of dockets, and retract the citation edges the split
 * invalidates.
 *
 * Clearing a decision's key retracts every edge drawn to it: what a citation
 * matched was a docket carrying a sheet number, which was never the docket.
 * Reopening those citations lets the standing resolver re-decide them against
 * the normalized key, instead of leaving edges nothing will ever revisit.
 */
export const normalizeSheetNumbersStatement = (limit: number): SQL => sql`
  WITH batch AS (
    SELECT id, citation_key AS old_key FROM case_law_decisions
    WHERE case_number ~ ${SHEET_PATTERN}
      AND source_document_id IS NOT NULL
    LIMIT ${limit}
  ),
  normalized AS (
    UPDATE case_law_decisions d
    SET case_number = regexp_replace(d.case_number, ${SHEET_PATTERN}, ${String.raw`\1`}),
        sheet_number = regexp_replace(d.case_number, ${SHEET_PATTERN}, ${String.raw`\2`}),
        citation_key = NULL
    FROM batch
    WHERE d.id = batch.id
    RETURNING d.id
  ),
  retracted AS (
    UPDATE case_law_citations c
       SET resolution_status = ${CITATION_RESOLUTION_STATUS.PENDING},
           cited_decision_id = NULL,
           resolution_rule_id = NULL
     WHERE c.cited_decision_id IN (SELECT id FROM batch)
       AND c.resolution_status = ${CITATION_RESOLUTION_STATUS.RESOLVED}
    RETURNING c.id
  ),
  -- The key these decisions are losing, not the one they will gain. A citation
  -- that went ambiguous because two decisions shared a sheet-bearing key holds
  -- no target, so the retraction above cannot reach it — and one of the two
  -- candidates leaving the key is exactly what makes the other unique. The key
  -- backfill that follows announces the new key, which says nothing about the
  -- old one, so this is the only place those rows are reachable.
  requeued AS (
    UPDATE case_law_citations c
       SET resolution_status = ${CITATION_RESOLUTION_STATUS.PENDING},
           resolution_rule_id = NULL
     WHERE c.citation_key IN (
             SELECT old_key FROM batch WHERE old_key IS NOT NULL
           )
       AND ${citationReopenableByKeySql(sql.raw("c.resolution_status"))}
    RETURNING c.id
  )
  SELECT (SELECT count(*)::int FROM normalized) AS normalized,
         (SELECT count(*)::int FROM retracted)
         + (SELECT count(*)::int FROM requeued) AS reopened
`;
