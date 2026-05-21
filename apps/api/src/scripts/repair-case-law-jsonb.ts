/**
 * Repair case_law_decisions rows whose JSONB columns were stored
 * as JSON-encoded strings instead of objects/arrays.
 *
 * Background: a previous version of the ingestion pipeline passed
 * objects directly to Drizzle's jsonb column on the bun-sql driver,
 * which double-stringified the payload. Affected columns:
 * document_ast, metadata, sections, analysis. The PR that
 * introduces this script also fixes the ingestion writer; the
 * analysis writer fix lives in a separate PR.
 *
 * Strategy: paginate by id (UUID asc), batch-update rows where any
 * of the four columns is a jsonb string. Each column is unwrapped
 * with `(col #>> '{}')::jsonb` only when its current jsonb_typeof
 * is 'string'; rows already correct are skipped. Idempotent — safe
 * to re-run.
 *
 * Usage:
 *   bun apps/api/src/scripts/repair-case-law-jsonb.ts
 *
 * The script runs against DATABASE_URL. In production this is meant
 * to be invoked from the utility-worker over an SSM tunnel, the
 * same way migrations run.
 *
 * Operational notes:
 * - Run only after the pipeline fix is deployed; otherwise the
 *   ingestion pipeline keeps writing new string-wrapped rows behind
 *   the cursor.
 * - Safe to run while ingestion is live. Postgres row-level locks
 *   serialize concurrent UPDATEs on the same row; with the fix
 *   deployed, any row written or refreshed after that point is an
 *   object, and the WHERE clause skips it.
 */

import { sql } from "drizzle-orm";

import { rootDb } from "@/api/db/root";

const BATCH_SIZE = 2000;
const STATEMENT_TIMEOUT_MS = 120_000;

type BatchResult = {
  next_cursor: string | null;
  scanned: number;
  updated: number;
};

const repairBatch = async (
  cursorId: string | null,
): Promise<BatchResult | null> => {
  const cursorClause = cursorId ? sql`WHERE id > ${cursorId}::uuid` : sql``;

  const rows = await rootDb.execute(sql`
    WITH batch AS (
      SELECT id
      FROM case_law_decisions
      ${cursorClause}
      ORDER BY id
      LIMIT ${BATCH_SIZE}
    ),
    updated AS (
      UPDATE case_law_decisions d
      SET
        document_ast = CASE
          WHEN jsonb_typeof(d.document_ast) = 'string'
          THEN (d.document_ast #>> '{}')::jsonb
          ELSE d.document_ast
        END,
        metadata = CASE
          WHEN jsonb_typeof(d.metadata) = 'string'
          THEN (d.metadata #>> '{}')::jsonb
          ELSE d.metadata
        END,
        sections = CASE
          WHEN d.sections IS NOT NULL
            AND jsonb_typeof(d.sections) = 'string'
          THEN (d.sections #>> '{}')::jsonb
          ELSE d.sections
        END,
        analysis = CASE
          WHEN d.analysis IS NOT NULL
            AND jsonb_typeof(d.analysis) = 'string'
          THEN (d.analysis #>> '{}')::jsonb
          ELSE d.analysis
        END
      FROM batch
      WHERE d.id = batch.id
        AND (
          jsonb_typeof(d.document_ast) = 'string'
          OR jsonb_typeof(d.metadata) = 'string'
          OR (
            d.sections IS NOT NULL
            AND jsonb_typeof(d.sections) = 'string'
          )
          OR (
            d.analysis IS NOT NULL
            AND jsonb_typeof(d.analysis) = 'string'
          )
        )
      RETURNING d.id
    )
    SELECT
      (SELECT id::text FROM batch ORDER BY id DESC LIMIT 1) AS next_cursor,
      (SELECT count(*)::int FROM batch) AS scanned,
      (SELECT count(*)::int FROM updated) AS updated
  `);

  const row = rows.at(0);
  if (!row) {
    return null;
  }
  return {
    next_cursor:
      typeof row["next_cursor"] === "string" ? row["next_cursor"] : null,
    scanned: Number(row["scanned"] ?? 0),
    updated: Number(row["updated"] ?? 0),
  };
};

const formatDuration = (ms: number): string => {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${h}h${m.toString().padStart(2, "0")}m${sec.toString().padStart(2, "0")}s`;
};

const main = async () => {
  // Lift the per-statement timeout for this session so a heavy
  // batch that has to read TOAST pages doesn't get cancelled mid-
  // way through a write.
  await rootDb.execute(
    sql.raw(`SET statement_timeout = ${STATEMENT_TIMEOUT_MS}`),
  );

  console.log("Starting case_law_decisions JSONB repair");
  console.log(
    `Batch size: ${BATCH_SIZE}, statement timeout: ${STATEMENT_TIMEOUT_MS}ms`,
  );

  let cursor: string | null = null;
  let totalScanned = 0;
  let totalUpdated = 0;
  let batchCount = 0;
  const startedAt = performance.now();

  while (true) {
    const batchStart = performance.now();
    const result = await repairBatch(cursor);

    if (!result || result.scanned === 0) {
      break;
    }

    totalScanned += result.scanned;
    totalUpdated += result.updated;
    batchCount++;

    const batchMs = Math.round(performance.now() - batchStart);
    console.log(
      `[batch ${batchCount}] scanned=${result.scanned} ` +
        `updated=${result.updated} ` +
        `total_scanned=${totalScanned} ` +
        `total_updated=${totalUpdated} ` +
        `took=${batchMs}ms ` +
        `cursor=${result.next_cursor ?? "<end>"}`,
    );

    if (!result.next_cursor) {
      break;
    }
    cursor = result.next_cursor;
  }

  const elapsed = performance.now() - startedAt;
  console.log(
    `\nDone. Scanned ${totalScanned} rows, updated ${totalUpdated}. ` +
      `Elapsed ${formatDuration(elapsed)}.`,
  );

  process.exit(0);
};

main().catch((error: unknown) => {
  console.error("Fatal:", error);
  process.exit(1);
});
