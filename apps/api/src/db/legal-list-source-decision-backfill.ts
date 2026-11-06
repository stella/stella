import { LIST_ITEM_SOURCE_REVIEW_DECISION } from "@/api/lib/lists/review-decision-maps";
import { SQL_NULL, sqlCaseExpression } from "@/api/lib/sql-case-expression";

import type { OnlineRepair } from "./online-migration-connection";

const BATCH_SIZE = 500;
const PENDING_DECISIONS = `
  FROM public.legal_list_item_sources source
  WHERE source.verification_status <> 'unverified'
    AND NOT EXISTS (
      SELECT 1 FROM public.legal_list_item_source_decisions event
      WHERE event.source_id = source.id
    )`;

/** The shared decision for each stored status, from the one map that owns it. */
const DECISION_SQL = sqlCaseExpression({
  branches: Object.entries(LIST_ITEM_SOURCE_REVIEW_DECISION).map(
    ([status, decision]) =>
      `WHEN source.verification_status = '${status}' THEN ${decision === null ? SQL_NULL : `'${decision}'`}`,
  ),
  fallback: SQL_NULL,
});

/** Existing current-state decisions gain their original actor and timestamp.
 * The anti-join is its checkpoint: a committed row cannot be selected again.
 * The baseline event takes its source's id, as the verification handler's
 * does, so a source changed while this runs keeps exactly one baseline. The
 * gate trigger stamps each event's feature gate from its source. */
export const LEGAL_LIST_SOURCE_DECISION_BACKFILL = {
  introducedBy: "20261030093000_legal_list_item_source_decisions",
  name: "legal-list-source-decisions",
  readCompletion: async (connection) => {
    const pending = await connection.query(
      `SELECT source.id ${PENDING_DECISIONS} LIMIT 1`,
      [],
    );
    return pending.length === 0
      ? { type: "complete" }
      : {
          type: "incomplete",
          reason: "List source decision history is pending",
        };
  },
  repair: async (connection) => {
    for (;;) {
      const rows = await connection.query(
        `WITH batch AS (
            SELECT source.id ${PENDING_DECISIONS}
            ORDER BY source.id
            LIMIT $1
          )
          INSERT INTO public.legal_list_item_source_decisions
            (id, workspace_id, source_id, decision, actor_id, created_at)
          SELECT
            source.id, source.workspace_id, source.id, ${DECISION_SQL},
            source.verified_by, COALESCE(source.verified_at, source.updated_at)
          FROM public.legal_list_item_sources source
          JOIN batch ON batch.id = source.id
          ON CONFLICT (id) DO NOTHING
          RETURNING source_id`,
        [BATCH_SIZE],
      );
      if (rows.length === 0) {
        return { type: "complete" } as const;
      }
    }
  },
} satisfies OnlineRepair;
