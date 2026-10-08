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
import { runBackfillPass } from "@stll/db-load-gate/backfill-pass";
import { runScriptWithErrorOutput } from "@stll/errors";

import { createScriptBackfillRuntime } from "@/api/db/backfill-runtime";
import {
  loadCitationCourtWeightEntries,
  recomputeCitationAuthorityBatch,
} from "@/api/handlers/case-law/citation-authority";
import { enterCaseLawMaintenanceLane } from "@/api/lib/case-law/maintenance-lane";
import { backfillEntrypoints } from "@/api/scripts/backfill-entrypoint";

// Hold the maintenance lane before the first statement: operator passes over
// the case-law tables serialize here instead of deadlocking on row locks.
await runScriptWithErrorOutput(async () => {
  const { rootDb } = await enterCaseLawMaintenanceLane();

  const plan = backfillEntrypoints["citation-authority"]({
    args: process.argv.slice(2),
  });
  const { asOf, after: rawAfter } = plan;

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

  const runtime = plan.open((options) =>
    createScriptBackfillRuntime({ ...options, db: rootDb }),
  );
  try {
    const pass = await runBackfillPass({
      step: async () => {
        const result = await runtime.step(async ({ tx, size, cursor }) => {
          const batch = await recomputeCitationAuthorityBatch(tx, {
            after: cursor ?? rawAfter ?? null,
            limit: size,
            now: { type: "pinned", at: asOf },
            courtWeightEntries,
          });
          return {
            cursor: batch.lastId ?? cursor,
            done: batch.scanned < size,
            value: batch,
          };
        });
        return {
          ...result,
          value: { batch: result.value, cursor: result.cursor },
        };
      },
      onBatch: ({ value: { batch, cursor } }) => {
        scanned += batch.scanned;
        written += batch.written;
        cited += batch.cited;
        after = cursor ?? after;
        console.log(
          `  ${scanned} examined, ${written} rewritten, ${cited} cited; last ${after ?? "-"}`,
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
    `Done. ${scanned} decisions examined, ${written} rewritten, ${cited} carry a citation.`,
  );

  process.exit(0);
});
