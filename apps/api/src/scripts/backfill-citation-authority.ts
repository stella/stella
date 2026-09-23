/**
 * Materialize `citation_authority` / `citation_count` across the whole
 * case-law corpus, on demand.
 *
 * The corpus daemon keeps this fresh on its own schedule; this is the
 * operator's handle on the same machinery, for seeding a corpus that has never
 * been swept or forcing the time-decayed values forward after a ranking change.
 *
 * One pass over the corpus in id order, with decay evaluated at one instant
 * for the whole run. Like the daemon, it writes only the decisions whose value
 * moved, and it leaves the daemon's own position alone, so it can run while
 * the daemon does.
 *
 * **Resuming.** Every batch prints the last decision it examined. Pass it back
 * with `--after`, and the instant from the first line with `--as-of`, to
 * continue an interrupted run on the same terms:
 *
 *   bun apps/api/src/scripts/backfill-citation-authority.ts
 *   bun apps/api/src/scripts/backfill-citation-authority.ts --as-of 2026-08-16T12:00:00.000Z --after <decision id>
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

// One instant for the whole run, so the first decision and the last are ranked
// on identical terms, and a resumed run can be handed the same one.
const rawAsOf = flag("--as-of");
const asOf = rawAsOf === undefined ? new Date() : new Date(rawAsOf);
if (Number.isNaN(asOf.getTime())) {
  panic("--as-of requires an ISO timestamp");
}

const rawAfter = flag("--after");
if (
  rawAfter !== undefined &&
  !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(
    rawAfter,
  )
) {
  panic("--after requires a decision id");
}

console.log("=== BACKFILL CITATION AUTHORITY ===");
console.log(
  `Sweep instant: ${asOf.toISOString()} ` +
    "(pass it back with --as-of, with --after, to resume this run)",
);

const courtWeightEntries = await loadCitationCourtWeightEntries();

let after: string | null = rawAfter ?? null;
let scanned = 0;
let written = 0;
let cited = 0;

while (true) {
  const position = after;
  // oxlint-disable-next-line no-db-await-in-loop/no-db-await-in-loop -- bounded keyset batch per iteration; the next batch starts where this one stopped
  const batch = await rootDb.transaction(
    async (tx) =>
      await recomputeCitationAuthorityBatch(tx, {
        after: position,
        limit: BATCH,
        now: { type: "pinned", at: asOf },
        courtWeightEntries,
      }),
  );
  scanned += batch.scanned;
  written += batch.written;
  cited += batch.cited;
  after = batch.lastId ?? after;
  console.log(
    `  ${scanned} examined, ${written} rewritten, ${cited} cited; last ${after ?? "-"}`,
  );
  if (batch.scanned < BATCH) {
    break;
  }
}

console.log(
  `Done. ${scanned} decisions examined, ${written} rewritten, ${cited} carry a citation.`,
);

process.exit(0);
