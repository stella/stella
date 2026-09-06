/**
 * Materialize `citation_authority` / `citation_count` across the whole
 * case-law corpus, on demand.
 *
 * The corpus daemon keeps this fresh on a rolling window; this is the
 * operator's handle on the same machinery, for seeding a corpus that has never
 * been swept or forcing the time-decayed values forward after a ranking change.
 *
 * A sweep here is pinned to one instant: every decision last computed *before*
 * it is due, and every decision it recomputes is stamped with it. Each batch is
 * one bounded statement, and a recomputed decision drops out of the set, so the
 * walk advances by doing its work.
 *
 * What completion guarantees is a floor: no decision was last computed before
 * that instant. A row the daemon's rolling loop recomputed after it is already
 * fresher and is left alone, which is why this can run while the daemon does.
 *
 * **Resuming.** Re-running with a fresh instant is a *new* sweep and recomputes
 * the whole corpus, because every row the interrupted run stamped is older than
 * the new boundary. To resume the interrupted one instead, pass the instant it
 * printed on its first line:
 *
 *   bun apps/api/src/scripts/backfill-citation-authority.ts
 *   bun apps/api/src/scripts/backfill-citation-authority.ts --as-of 2026-08-16T12:00:00.000Z
 *   bun apps/api/src/scripts/backfill-citation-authority.ts --batch 2000
 */
import { panic } from "better-result";

import {
  loadCitationCourtWeightEntries,
  recomputeCitationAuthorityBatch,
} from "@/api/handlers/case-law/citation-authority";
import { enterCaseLawMaintenanceLane } from "@/api/lib/case-law/maintenance-lane";

// Hold the maintenance lane before the first statement: operator passes over
// the case-law tables serialize here instead of deadlocking on row locks.
const { rootDb } = await enterCaseLawMaintenanceLane();

/**
 * A flag's value, or undefined when the flag is absent.
 *
 * An absent flag and a flag whose value is missing are different mistakes: the
 * first means "use the default", the second means the operator typed something
 * they expect to take effect. Silently defaulting the second is the failure
 * mode worth refusing, because a `--batch` that reads 5000 when the operator
 * asked for 500 does not announce itself.
 */
const flag = (name: string): string | undefined => {
  const at = process.argv.indexOf(name);
  if (at === -1) {
    return undefined;
  }
  const value = process.argv[at + 1];
  if (value === undefined || value.startsWith("--")) {
    return panic(`${name} requires a value`);
  }
  return value;
};

const rawBatch = flag("--batch");
const BATCH = rawBatch === undefined ? 5000 : Number(rawBatch);
if (!Number.isInteger(BATCH) || BATCH < 1) {
  panic("--batch requires a positive integer");
}

// One instant for the whole run, and the same instant the batches stamp with.
// Deriving the boundary and the stamp from one value is what makes the sweep
// converge: a boundary from a host clock running even milliseconds ahead of
// PostgreSQL would leave every row this run stamped still older than it, and
// the walk would rewrite the same oldest rows forever.
const rawAsOf = flag("--as-of");
const asOf = rawAsOf === undefined ? new Date() : new Date(rawAsOf);
if (Number.isNaN(asOf.getTime())) {
  panic("--as-of requires an ISO timestamp");
}

console.log("=== BACKFILL CITATION AUTHORITY ===");
console.log(
  `Sweep instant: ${asOf.toISOString()} ` +
    "(pass it back with --as-of to resume this sweep rather than start a new one)",
);

const courtWeightEntries = await loadCitationCourtWeightEntries();

let recomputed = 0;
let cited = 0;

while (true) {
  // oxlint-disable-next-line no-db-await-in-loop/no-db-await-in-loop -- bounded batch per iteration under the graph lock
  const batch = await rootDb.transaction(
    async (tx) =>
      await recomputeCitationAuthorityBatch(tx, {
        limit: BATCH,
        window: { type: "pinned", at: asOf },
        courtWeightEntries,
      }),
  );
  if (batch.recomputed === 0) {
    break;
  }
  recomputed += batch.recomputed;
  cited += batch.cited;
  console.log(`  ${recomputed} decisions recomputed, ${cited} of them cited`);
}

console.log(
  `Done. ${recomputed} decisions recomputed, ${cited} carry a citation.`,
);

process.exit(0);
