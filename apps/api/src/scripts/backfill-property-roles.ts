import { panic } from "better-result";
import { sql } from "drizzle-orm";

/**
 * Backfill legacy workspace "Document Type" classifiers into properties.role.
 *
 * New writes set the role directly. This script is only for existing workspaces
 * that predate the role column; it batches by workspace so each statement ranks
 * a bounded slice of properties and can be safely re-run.
 *
 *   bun run src/scripts/backfill-property-roles.ts
 */
import { runBackfillPass } from "@stll/db-load-gate/backfill-pass";

import { createScriptBackfillRuntime } from "@/api/db/backfill-runtime";
import type { Transaction } from "@/api/db/root";
import { setSharedStatementTimeout } from "@/api/db/shared-pool-timeouts";
import { openMaintenanceDb } from "@/api/lib/db/maintenance-db";
import { backfillEntrypoints } from "@/api/scripts/backfill-entrypoint";

const plan = backfillEntrypoints["property-roles"]({
  args: process.argv.slice(2),
  environment: process.env,
});
const STATEMENT_TIMEOUT_MS = 60_000;

const db = openMaintenanceDb({ readOnly: false });

type BatchResult = {
  next_cursor: string | null;
  scanned_workspaces: number;
  updated: number;
};

type BackfillBatchOptions = {
  tx: Transaction;
  cursorWorkspaceId: string | null;
  size: number;
};
const backfillBatch = async ({
  tx,
  cursorWorkspaceId,
  size,
}: BackfillBatchOptions): Promise<BatchResult> => {
  const cursorClause = cursorWorkspaceId
    ? sql`WHERE workspace_id > ${cursorWorkspaceId}::uuid`
    : sql``;

  await setSharedStatementTimeout(tx, STATEMENT_TIMEOUT_MS);

  const rows = await tx.execute(sql`
      WITH workspace_batch AS (
        SELECT workspace_id
        FROM (
          SELECT DISTINCT workspace_id
          FROM properties
          ${cursorClause}
          ORDER BY workspace_id
          LIMIT ${size}
        ) AS workspace_ids
      ),
      ranked AS (
        SELECT
          p.id,
          p.workspace_id,
          row_number() OVER (
            PARTITION BY p.workspace_id
            ORDER BY p.created_at ASC, p.id ASC
          ) AS rn
        FROM properties p
        INNER JOIN workspace_batch wb ON wb.workspace_id = p.workspace_id
        WHERE lower(trim(p.name)) = 'document type'
          AND p.content->>'type' = 'single-select'
          AND p.tool->>'type' = 'ai-model'
      ),
      candidates AS (
        SELECT id, workspace_id
        FROM ranked
        WHERE rn = 1
      ),
      updated AS (
        UPDATE properties p
        SET role = 'document-type-classifier'
        FROM candidates c
        WHERE p.id = c.id
          AND p.role IS DISTINCT FROM 'document-type-classifier'
          AND NOT EXISTS (
            SELECT 1
            FROM properties existing
            WHERE existing.workspace_id = p.workspace_id
              AND existing.role = 'document-type-classifier'
              AND existing.id <> p.id
          )
        RETURNING p.id
      )
      SELECT
        (
          SELECT workspace_id::text
          FROM workspace_batch
          ORDER BY workspace_id DESC
          LIMIT 1
        ) AS next_cursor,
        (SELECT count(*)::int FROM workspace_batch) AS scanned_workspaces,
        (SELECT count(*)::int FROM updated) AS updated
    `);

  const row = rows.at(0);
  if (!row) {
    return panic("Property role batch returned no result");
  }

  return {
    next_cursor:
      typeof row["next_cursor"] === "string" ? row["next_cursor"] : null,
    scanned_workspaces: Number(row["scanned_workspaces"] ?? 0),
    updated: Number(row["updated"] ?? 0),
  };
};

console.log("=== BACKFILL PROPERTY ROLES ===");
console.log(
  `Workspace batch size: ${plan.initialSize}, statement timeout: ${STATEMENT_TIMEOUT_MS}ms`,
);

let totalScannedWorkspaces = 0;
let totalUpdated = 0;
let batchCount = 0;
const runtime = await plan.open((options) =>
  createScriptBackfillRuntime({ ...options, db }),
);

try {
  const pass = await runBackfillPass({
    step: async () =>
      await runtime.step(async ({ tx, size, cursor }) => {
        const value = await backfillBatch({
          tx,
          size,
          cursorWorkspaceId: cursor,
        });
        return {
          cursor: value.next_cursor ?? cursor,
          done: value.scanned_workspaces === 0 || value.next_cursor === null,
          value,
        };
      }),
    onBatch: ({ value: result }) => {
      if (result.scanned_workspaces === 0) {
        return;
      }

      totalScannedWorkspaces += result.scanned_workspaces;
      totalUpdated += result.updated;
      batchCount++;

      console.log(
        `[batch ${batchCount}] scanned_workspaces=${result.scanned_workspaces} ` +
          `updated=${result.updated} ` +
          `total_scanned_workspaces=${totalScannedWorkspaces} ` +
          `total_updated=${totalUpdated} ` +
          `cursor=${result.next_cursor ?? "<end>"}`,
      );
    },
    sleep: Bun.sleep,
  });
  if (pass.isErr()) {
    throw pass.error;
  }
} finally {
  await runtime.close();
}

console.log(
  `Done. Scanned ${totalScannedWorkspaces} workspaces, updated ${totalUpdated} properties.`,
);
