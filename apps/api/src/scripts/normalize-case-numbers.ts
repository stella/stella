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
 * `citation_key` is cleared in the same statement, since it derives from the
 * case number and would otherwise keep pointing at the un-normalized form, and
 * the citations resolved to those decisions are reopened with it.
 *
 * Idempotent: a row already split no longer matches the pattern.
 *
 *   bun apps/api/src/scripts/normalize-case-numbers.ts
 *   bun apps/api/src/scripts/normalize-case-numbers.ts --dry-run
 */

import { lockCitationGraph } from "@/api/handlers/case-law/citation-resolution";
import { enterCaseLawMaintenanceLane } from "@/api/lib/case-law/maintenance-lane";
import { isRecord } from "@/api/lib/type-guards";
import {
  normalizeSheetNumbersStatement,
  sheetNumberSurveyStatement,
} from "@/api/scripts/normalize-case-numbers-sql";

// Hold the maintenance lane before the first statement: operator passes over
// the case-law tables serialize here instead of deadlocking on row locks.
const { rootDb } = await enterCaseLawMaintenanceLane();

const BATCH = 2000;
const DRY_RUN = process.argv.includes("--dry-run");

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

const firstNumber = (result: unknown, key: string): number => {
  const row = executedRows(result).at(0);
  return isRecord(row) && typeof row[key] === "number" ? row[key] : 0;
};

if (DRY_RUN) {
  const counts = await rootDb.execute(sheetNumberSurveyStatement());
  console.info(
    `carry a sheet number: ${firstNumber(counts, "ready").toLocaleString()} ready, ` +
      `${firstNumber(counts, "blocked").toLocaleString()} still identified by case number (run the id backfill first)`,
  );
  process.exit(0);
}

let normalized = 0;
let reopened = 0;

while (true) {
  // The graph lock, then the statement, in one transaction. This changes what
  // decisions are citable, so it is a graph mutation like any other: without
  // the lock a resolver batch holding a snapshot from before the key was
  // cleared can commit a `resolved` edge to a decision that no longer carries
  // that key, and nothing revisits it.
  // oxlint-disable-next-line no-db-await-in-loop/no-db-await-in-loop -- bounded batch per iteration under the graph lock
  const result = await rootDb.transaction(async (tx) => {
    await lockCitationGraph(tx);
    return await tx.execute(normalizeSheetNumbersStatement(BATCH));
  });
  const batch = firstNumber(result, "normalized");
  if (batch === 0) {
    break;
  }
  normalized += batch;
  reopened += firstNumber(result, "reopened");
  console.info(`${normalized.toLocaleString()} normalized`);
}

console.info(
  `done, ${normalized.toLocaleString()} rows normalized, ` +
    `${reopened.toLocaleString()} citations reopened. ` +
    "Re-run backfill-citation-keys.ts to refill citation_key.",
);

process.exit(0);
