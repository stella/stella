import { DOCUMENT_REVIEW_FINDING_DECISION } from "@/api/lib/document-review/run-contract";
import { SQL_NULL, sqlCaseExpression } from "@/api/lib/sql-case-expression";

import type { OnlineRepair } from "./online-migration-connection";

const BATCH_SIZE = 500;
const PENDING_DECISIONS = `
  FROM public.document_review_findings finding
  WHERE finding.decision <> 'open'
    AND NOT EXISTS (
      SELECT 1 FROM public.document_review_finding_decisions event
      WHERE event.finding_id = finding.id
    )`;

/** The shared decision for each stored word, from the one map that owns it. */
const DECISION_SQL = sqlCaseExpression({
  branches: Object.entries(DOCUMENT_REVIEW_FINDING_DECISION).map(
    ([stored, decision]) =>
      `WHEN finding.decision = '${stored}' THEN ${decision === null ? SQL_NULL : `'${decision}'`}`,
  ),
  fallback: SQL_NULL,
});

/** Existing current-state decisions gain their original actor and timestamp.
 * The anti-join is its checkpoint: a committed row cannot be selected again. */
export const DOCUMENT_REVIEW_FINDING_DECISION_BACKFILL = {
  name: "document-review-finding-decisions",
  readCompletion: async (connection) => {
    const pending = await connection.query(
      `SELECT finding.id ${PENDING_DECISIONS} LIMIT 1`,
      [],
    );
    return pending.length === 0
      ? { type: "complete" }
      : { type: "incomplete", reason: "Finding decision history is pending" };
  },
  repair: async (connection) => {
    await connection.execute("SET statement_timeout = '60s'");
    try {
      for (;;) {
        const rows = await connection.query(
          `WITH batch AS (
            SELECT finding.id ${PENDING_DECISIONS}
            ORDER BY finding.id
            LIMIT $1
          )
          INSERT INTO public.document_review_finding_decisions
            (id, workspace_id, finding_id, decision, reason, actor_id, created_at)
          SELECT
            gen_random_uuid(), finding.workspace_id, finding.id, ${DECISION_SQL},
            NULL, finding.decided_by, finding.decided_at
          FROM public.document_review_findings finding
          JOIN batch ON batch.id = finding.id
          RETURNING finding_id`,
          [BATCH_SIZE],
        );
        if (rows.length === 0) {
          return { type: "complete" } as const;
        }
      }
    } finally {
      await connection.execute("SET statement_timeout = 0");
    }
  },
} satisfies OnlineRepair;
