/**
 * Reduce stored reference passages to ids (`lib/document-review/
 * passage-reference-normalize.ts`). Each step runs in bounded batches, one
 * transaction per batch, until no row carries passage words. Every step is
 * idempotent, so the script can run again after any deploy.
 *
 *   bun run --env-file=.env src/scripts/normalize-review-passage-references.ts [--dry-run]
 */
import { sql } from "drizzle-orm";

import { openMaintenanceDb } from "@/api/lib/db/maintenance-db";
import {
  PASSAGE_REFERENCE_STEPS,
  PASSAGES_BY_ID_FUNCTION,
  POSITION_ITEMS_BY_ID_FUNCTION,
} from "@/api/lib/document-review/passage-reference-normalize";

const BATCH_SIZE = 200;
const STATEMENT_TIMEOUT = "60000ms";

type Step = (typeof PASSAGE_REFERENCE_STEPS)[number];

const rewriteBatch = async ({ rewrite }: Step): Promise<number> =>
  await db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT set_config('statement_timeout', ${STATEMENT_TIMEOUT}, true)`,
    );
    await tx.execute(PASSAGES_BY_ID_FUNCTION);
    await tx.execute(POSITION_ITEMS_BY_ID_FUNCTION);
    const rows = await tx.execute<{ changed: number }>(rewrite(BATCH_SIZE));
    return rows.at(0)?.changed ?? 0;
  });

/** Repeats a step's batch until a batch comes back short. */
const runStep = async (step: Step, total = 0): Promise<number> => {
  const changed = await rewriteBatch(step);
  return changed < BATCH_SIZE
    ? total + changed
    : await runStep(step, total + changed);
};

const report = async (
  steps: readonly Step[],
  dryRun: boolean,
): Promise<void> => {
  const [current, ...rest] = steps;
  if (current === undefined) {
    return;
  }
  if (dryRun) {
    const counted = await db.execute<{ pending: number }>(current.pending);
    console.log(
      `${current.name}: ${String(counted.at(0)?.pending ?? 0)} row(s) to rewrite`,
    );
  } else {
    const total = await runStep(current);
    console.log(`${current.name}: rewrote ${String(total)} row(s)`);
  }
  await report(rest, dryRun);
};

const dryRun = process.argv.includes("--dry-run");
const db = openMaintenanceDb({ readOnly: dryRun });
console.log(
  `=== NORMALIZE REVIEW PASSAGE REFERENCES${dryRun ? " (dry run)" : ""} ===`,
);
await report(PASSAGE_REFERENCE_STEPS, dryRun);
process.exit(0);
