/**
 * Backfill legacy workspace "Document Type" classifiers into properties.role.
 *
 * New writes set the role directly. This script is only for existing workspaces
 * that predate the role column; it batches by workspace so each statement ranks
 * a bounded slice of properties and can be safely re-run.
 *
 *   bun run src/scripts/backfill-property-roles.ts
 */
import { sql } from "drizzle-orm";

import { rootDb } from "@/api/db/root";

const WORKSPACE_BATCH_SIZE = Number(
  process.env.PROPERTY_ROLE_BACKFILL_BATCH_SIZE ?? 100,
);
const STATEMENT_TIMEOUT_MS = 60_000;

type BatchResult = {
  next_cursor: string | null;
  scanned_workspaces: number;
  updated: number;
};

const backfillBatch = async (
  cursorWorkspaceId: string | null,
): Promise<BatchResult | null> => {
  const cursorClause = cursorWorkspaceId
    ? sql`WHERE workspace_id > ${cursorWorkspaceId}::uuid`
    : sql``;

  const rows = await rootDb.execute(sql`
    WITH workspace_batch AS (
      SELECT workspace_id
      FROM (
        SELECT DISTINCT workspace_id
        FROM properties
        ${cursorClause}
        ORDER BY workspace_id
        LIMIT ${WORKSPACE_BATCH_SIZE}
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
    return null;
  }

  return {
    next_cursor:
      typeof row["next_cursor"] === "string" ? row["next_cursor"] : null,
    scanned_workspaces: Number(row["scanned_workspaces"] ?? 0),
    updated: Number(row["updated"] ?? 0),
  };
};

await rootDb.execute(sql.raw(`SET statement_timeout = ${STATEMENT_TIMEOUT_MS}`));

console.log("=== BACKFILL PROPERTY ROLES ===");
console.log(
  `Workspace batch size: ${WORKSPACE_BATCH_SIZE}, statement timeout: ${STATEMENT_TIMEOUT_MS}ms`,
);

let cursor: string | null = null;
let totalScannedWorkspaces = 0;
let totalUpdated = 0;
let batchCount = 0;

while (true) {
  // oxlint-disable-next-line no-await-in-loop -- sequential workspace keyset pagination: the next cursor depends on this batch
  const result = await backfillBatch(cursor);

  if (!result || result.scanned_workspaces === 0) {
    break;
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

  if (!result.next_cursor) {
    break;
  }
  cursor = result.next_cursor;
}

console.log(
  `Done. Scanned ${totalScannedWorkspaces} workspaces, updated ${totalUpdated} properties.`,
);
