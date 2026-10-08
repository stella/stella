/**
 * Backfill: assign the public slug to every legislation_documents row that
 * predates slug-at-ingest. Run once before serving readable statute URLs in
 * an environment; safe to re-run (it only processes rows whose `slug` is
 * still null) and resumable (keyset by id).
 *
 *   bun run src/scripts/backfill-statute-slugs.ts
 *
 * Slug derivation reuses the helper the ingestion pipeline uses, so there is
 * a single source of truth for the algorithm.
 */
import { runBackfillPass } from "@stll/db-load-gate/backfill-pass";
import { runScriptWithErrorOutput } from "@stll/errors";

import { createScriptBackfillRuntime } from "@/api/db/backfill-runtime";
import { backfillStatuteSlugsPage } from "@/api/handlers/legislation/slug-backfill";
import { enterCaseLawMaintenanceLane } from "@/api/lib/case-law/maintenance-lane";
import { brandPersistedLegislationDocumentId } from "@/api/lib/safe-id-boundaries";
import { backfillEntrypoints } from "@/api/scripts/backfill-entrypoint";

// Hold the maintenance lane before the first statement: operator passes over
// the corpus tables serialize here instead of deadlocking on row locks.
const plan = backfillEntrypoints["statute-slugs"]({
  args: process.argv.slice(2),
});

await runScriptWithErrorOutput(async () => {
  const { rootDb } = await enterCaseLawMaintenanceLane();

  console.log("=== BACKFILL STATUTE SLUGS ===");

  const runtime = plan.open((options) =>
    createScriptBackfillRuntime({ ...options, db: rootDb }),
  );
  let written = 0;
  let skipped = 0;
  let failed = 0;
  try {
    const pass = await runBackfillPass({
      sleep: Bun.sleep,
      step: async () =>
        await runtime.step(async ({ tx, size, cursor }) => {
          const outcome = await backfillStatuteSlugsPage({
            db: async (work) => await work(tx),
            after:
              cursor === null
                ? null
                : brandPersistedLegislationDocumentId(cursor),
            size,
          });
          if (outcome.isErr()) {
            throw outcome.error.cause;
          }
          const page = outcome.value;
          return { cursor: page.cursor, done: page.done, value: page };
        }),
      onBatch: ({ value }) => {
        written += value.written;
        skipped += value.skipped;
        failed += value.failed;
      },
    });
    if (pass.isErr()) {
      throw pass.error;
    }
  } finally {
    await runtime.close();
  }

  console.log(
    `Done. Wrote ${written} slugs, skipped ${skipped} (no citation in the ELI), ${failed} failed.`,
  );

  // Non-zero on failure: a launch treats this run as green only when every
  // document that can carry a slug has one.
  process.exit(failed === 0 ? 0 : 1);
});
