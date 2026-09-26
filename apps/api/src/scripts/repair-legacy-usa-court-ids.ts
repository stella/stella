/**
 * Give USA decisions stored before court ids existed the id of the court they
 * name, where that court is a trusted identity, before migration
 * 20260926110000_case_law_decision_court_id is applied.
 *
 * The migration enables a CHECK that every USA row carries a court id, and
 * refuses to run while one does not: the CHECK is enforced on every later
 * update of an old row, so a USA row without an id would become unwritable.
 * Drizzle applies pending migrations in one transaction, so the repair cannot
 * sit between two of them; this script adds the same nullable column the
 * migration adds (`ADD COLUMN IF NOT EXISTS`, which the migration then keeps)
 * and assigns ids ahead of the upgrade.
 *
 * Only a row whose court is exactly the canonical name of a trusted court
 * (`legacyTrustedUsaCourts`: the courts the earlier write contract admitted)
 * is assigned an id. Every other USA row is reported by court name and left
 * alone, to be resolved from its source; no id is inferred from a name.
 *
 *   # what the migration would refuse, writing nothing
 *   bun run src/scripts/repair-legacy-usa-court-ids.ts
 *
 *   # add the column and repair trusted rows, bounded and resumable
 *   bun run src/scripts/repair-legacy-usa-court-ids.ts --apply [--limit 5000]
 */
import { sql } from "drizzle-orm";

import {
  enterCaseLawMaintenanceLane,
  openCaseLawReadOnlySession,
} from "@/api/lib/case-law/maintenance-lane";
import { flagInteger, readApplyFlag } from "@/api/scripts/repair-flags";
import {
  ENSURE_DECISION_COURT_ID_COLUMN_SQL,
  decisionCourtIdColumnExists,
  legacyUsaCourtIdCensus,
  repairLegacyUsaCourtIdBatch,
} from "@/api/scripts/repair-legacy-usa-court-ids-plan";

/** Rows per transaction: small, since each holds its rows' locks. */
const BATCH = 500;
const DEFAULT_LIMIT = 5000;

const USAGE = `Usage: bun run src/scripts/repair-legacy-usa-court-ids.ts [options]

  --apply        Add the column and repair. Omitted, the run only reports.
  --dry-run      Report only, the default; contradicts --apply.
  --limit <n>    Rows this run may repair (default ${String(DEFAULT_LIMIT)}).`;

const apply = readApplyFlag(USAGE);
const { rootDb } = apply
  ? await enterCaseLawMaintenanceLane()
  : await openCaseLawReadOnlySession();
const limit = flagInteger({
  fallback: DEFAULT_LIMIT,
  name: "limit",
  usage: USAGE,
});

const report = async (): Promise<number> => {
  const census = await legacyUsaCourtIdCensus(rootDb, {
    columnExists: await decisionCourtIdColumnExists(rootDb),
  });
  let untrusted = 0;
  for (const { court, rows, trusted } of census) {
    console.info(
      `${String(rows).padStart(7)}  ${trusted ? "repairable" : "source it"}  ${court}`,
    );
    untrusted += trusted ? 0 : rows;
  }
  const total = census.reduce((sum, { rows }) => sum + rows, 0);
  console.info(
    `${String(total)} USA rows without a court id, ${String(untrusted)} of them not repairable here`,
  );
  return total;
};

await report();
if (!apply) {
  console.info("Report only: nothing written. Re-run with --apply to repair.");
  process.exit(0);
}

await rootDb.transaction(async (tx) => {
  await tx.execute(sql`SET LOCAL lock_timeout = '2s'`);
  await tx.execute(sql.raw(ENSURE_DECISION_COURT_ID_COLUMN_SQL));
});

const repairUntilDone = async (done: number): Promise<number> => {
  if (done >= limit) {
    return done;
  }
  const repaired = await rootDb.transaction(
    async (tx) =>
      await repairLegacyUsaCourtIdBatch(tx, Math.min(BATCH, limit - done)),
  );
  if (repaired.length === 0) {
    return done;
  }
  console.info(`${String(done + repaired.length)} repaired`);
  return await repairUntilDone(done + repaired.length);
};

const repaired = await repairUntilDone(0);
console.info(`done: ${String(repaired)} repaired.`);
const remaining = await report();
console.info(
  remaining === 0
    ? "no USA row lacks a court id: the migration can be applied."
    : `${String(remaining)} rows remain; the migration refuses to run until none do.`,
);
process.exit(0);
