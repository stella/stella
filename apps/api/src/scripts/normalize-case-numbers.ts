/**
 * Move the sheet number out of `case_number` into `sheet_number`.
 *
 * Some sources publish the docket with the sheet number within the court file
 * appended (`11 C 153/2025-28`). A citation names the docket alone, so while
 * the sheet stays on the case number nothing matches it, and one case appears
 * as a separate reference per sheet.
 *
 * **Ordering.** A row whose `source_document_id` is still NULL is identified by
 * its case number, so rewriting that number would collapse distinct rows onto
 * one key. Such rows are skipped, which makes this safe to run at any time and
 * makes `backfill-source-document-ids.ts` its prerequisite rather than a
 * assumption. Run that first; re-run this afterwards to pick up the rest.
 *
 * `citation_key` is recomputed in the same statement, since it derives from the
 * case number and would otherwise keep pointing at the un-normalized form.
 *
 * Idempotent: a row already split no longer matches the pattern.
 *
 *   bun apps/api/src/scripts/normalize-case-numbers.ts
 *   bun apps/api/src/scripts/normalize-case-numbers.ts --dry-run
 */

import { sql } from "drizzle-orm";

import { rootDb } from "@/api/db/root";
import { isRecord } from "@/api/lib/type-guards";

const BATCH = 2000;
const DRY_RUN = process.argv.includes("--dry-run");

/**
 * Trailing `-<digits>` on a docket that already carries a year — the same
 * shape `splitCaseReference` applies at ingest, expressed in SQL so a batch is
 * one statement. The year is what keeps references that merely end in a number
 * (`0T/42/2019`) from being split.
 */
const SHEET_PATTERN = String.raw`^(.*/\d{2,4})-(\d+)$`;

/** Rows from `execute` under either driver shape (bare array or `{ rows }`). */
const executedRows = (result: unknown): unknown[] => {
  if (Array.isArray(result)) {
    return result;
  }
  if (isRecord(result) && Array.isArray(result["rows"])) {
    return result["rows"];
  }
  return [];
};

const rowCount = (result: unknown): number => executedRows(result).length;

const firstNumber = (result: unknown, key: string): number => {
  const row = executedRows(result).at(0);
  return isRecord(row) && typeof row[key] === "number" ? row[key] : 0;
};

if (DRY_RUN) {
  const counts = await rootDb.execute(sql`
    SELECT
      count(*) FILTER (WHERE source_document_id IS NOT NULL)::int AS ready,
      count(*) FILTER (WHERE source_document_id IS NULL)::int AS blocked
    FROM case_law_decisions
    WHERE case_number ~ ${SHEET_PATTERN}
  `);
  console.info(
    `carry a sheet number: ${firstNumber(counts, "ready").toLocaleString()} ready, ` +
      `${firstNumber(counts, "blocked").toLocaleString()} still identified by case number (run the id backfill first)`,
  );
  process.exit(0);
}

/**
 * Normalize one batch and continue from wherever it stopped. A walk rather
 * than a loop: each step depends on the previous one having committed.
 */
const normalizeFrom = async (done: number): Promise<number> => {
  const result = await rootDb.execute(sql`
    WITH batch AS (
      SELECT id FROM case_law_decisions
      WHERE case_number ~ ${SHEET_PATTERN}
        AND source_document_id IS NOT NULL
      LIMIT ${BATCH}
    )
    UPDATE case_law_decisions d
    SET case_number = regexp_replace(d.case_number, ${SHEET_PATTERN}, ${String.raw`\1`}),
        sheet_number = regexp_replace(d.case_number, ${SHEET_PATTERN}, ${String.raw`\2`}),
        citation_key = NULL
    FROM batch
    WHERE d.id = batch.id
    RETURNING d.id
  `);

  const updated = rowCount(result);
  if (updated === 0) {
    return done;
  }
  const total = done + updated;
  console.info(`${total.toLocaleString()} normalized`);
  return await normalizeFrom(total);
};

const total = await normalizeFrom(0);
console.info(
  `done, ${total.toLocaleString()} rows. Re-run backfill-citation-keys.ts to refill citation_key.`,
);

process.exit(0);
