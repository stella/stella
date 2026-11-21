/**
 * Import the Czech Constitutional Court's roster of its justices, then link
 * the decisions whose judges were waiting for a roster row.
 *
 *   bun run src/scripts/import-cz-us-roster.ts
 *
 * Runs on a weekly schedule: the court appoints and retires justices and
 * replaces their portraits, and a roster read once goes stale. The import
 * itself is a few dozen requests to the court's site and one short write per
 * justice. The relink walks every decision of the court, so it runs as a
 * load-aware backfill pass: it shrinks under database load, and a hold that
 * outlasts {@link RELINK_MAX_WAIT_MS} pauses the pass at its saved checkpoint,
 * where the next run resumes it.
 */
import { Result } from "better-result";

import { runBackfillPass } from "@stll/db-load-gate/backfill-pass";
import { printError } from "@stll/errors";
import { runScriptWithErrorOutput } from "@stll/errors/script-error";

import { createScriptBackfillRuntime } from "@/api/db/backfill-runtime";
import { relinkUnmatchedDecisionJudgesPage } from "@/api/handlers/case-law/judges/decision-judges";
import {
  corpusPortraitStore,
  courtSiteFetch,
  CZ_US_ROSTER_COURT,
  CZ_US_ROSTER_REQUEST_INTERVAL_MS,
  czUsRosterStore,
  importCzUsRoster,
} from "@/api/handlers/case-law/judges/import-cz-us-roster";
import { enterCaseLawMaintenanceLane } from "@/api/lib/case-law/maintenance-lane";
import { brandPersistedCaseLawDecisionId } from "@/api/lib/safe-id-boundaries";
import { backfillEntrypoints } from "@/api/scripts/backfill-entrypoint";

/** How long the relink waits out a hold before it pauses until the next run. */
const RELINK_MAX_WAIT_MS = 30 * 60 * 1000;

const plan = backfillEntrypoints["cz-us-judge-relink"]({
  args: process.argv.slice(2),
});

await runScriptWithErrorOutput(async () => {
  // The maintenance lane is the door an operator pass takes to the case-law
  // tables and it holds a connection for the life of the process.
  const { ingestionDb, rootDb } = await enterCaseLawMaintenanceLane();

  const runtime = plan.open((options) =>
    createScriptBackfillRuntime({ ...options, db: rootDb }),
  );
  const relinkUnmatched = async (): Promise<number> => {
    let linked = 0;
    const pass = await runBackfillPass({
      sleep: Bun.sleep,
      maxWaitMs: RELINK_MAX_WAIT_MS,
      step: async () =>
        await runtime.step(async ({ tx, size, cursor }) => {
          const page = await relinkUnmatchedDecisionJudgesPage(tx, {
            ...CZ_US_ROSTER_COURT,
            after:
              cursor === null ? null : brandPersistedCaseLawDecisionId(cursor),
            size,
          });
          return { cursor: page.cursor, done: page.done, value: page };
        }),
      onBatch: ({ value }) => {
        linked += value.linked;
      },
    });
    if (pass.isErr()) {
      throw pass.error;
    }
    return linked;
  };

  const imported = await (async () => {
    try {
      return await importCzUsRoster({
        store: { ...czUsRosterStore(ingestionDb), relinkUnmatched },
        fetch: courtSiteFetch,
        s3: corpusPortraitStore,
        now: () => new Date(),
        intervalMs: CZ_US_ROSTER_REQUEST_INTERVAL_MS,
      });
    } finally {
      await runtime.close();
    }
  })();
  if (Result.isError(imported)) {
    printError(imported.error);
    process.exit(1);
  }
  process.stdout.write(`${JSON.stringify(imported.value, null, 2)}\n`);
  // Non-zero when a justice failed, so the schedule's alarm sees it; the rest
  // of the roster was still written.
  process.exit(imported.value.failures.length === 0 ? 0 : 1);
});
