import { sql } from "drizzle-orm";

import { keptTranscriptDeletions } from "@/api/db/schema";
import { runKeptTranscriptDeletions } from "@/api/lib/scheduler/tasks/kept-transcript-deletion";
import type { SchedulerTask } from "@/api/lib/scheduler/types";
import type { GatedTestClientScope } from "@/api/tests/gated-test-database";

import { measureScheduledTaskReplay } from "./scheduled-task-replay";
import { QUERY_PERF_CONNECTION_SETTINGS } from "./settings";

/** The run's batch: every due id, the ones ending in 0 refused. */
const DUE_TRANSCRIPTS = 50;

const fixtureRun: SchedulerTask = async (context) => {
  await runKeptTranscriptDeletions(context, {
    deployment: {
      apiKey: "fixture",
      environment: "default",
      zeroRetention: false,
    },
    deleteTranscript: async ({ transcriptionId }) =>
      await Promise.resolve(
        transcriptionId.endsWith("0")
          ? { type: "failed", code: "http_503" }
          : { type: "deleted" },
      ),
  });
};

/**
 * The fixed due batch, recorded more than an hour ago so the overdue report
 * reads it too, beside `history` recent ids that are not yet due.
 */
export const measureKeptTranscriptDeletionHistory = async (
  openClient: GatedTestClientScope["openClient"],
) => {
  const { db } = openClient({ connection: QUERY_PERF_CONNECTION_SETTINGS });
  const now = new Date("2026-10-29T00:00:00Z");
  const measurements = [];
  for (const history of [1000, 10_000]) {
    // db-await-in-loop: isolated measurement scenarios run sequentially, each reseeding its own disposable fixture table.
    await db.delete(keptTranscriptDeletions).where(sql`true`);
    // db-await-in-loop: seed the not-yet-due history before the due batch so a table scan has to cross it.
    await db.execute(sql`INSERT INTO kept_transcript_deletions (transcription_id, environment, next_attempt_at)
      SELECT 'history_' || n, 'default', now() + interval '1 hour' FROM generate_series(1, ${history}::integer) n`);
    // db-await-in-loop: the same due batch is present at both history sizes.
    await db.execute(sql`INSERT INTO kept_transcript_deletions (transcription_id, environment, attempts, next_attempt_at, created_at)
      SELECT 'due_' || n, 'default', 4, now() - interval '1 minute', now() - interval '2 hours' FROM generate_series(1, ${DUE_TRANSCRIPTS}::integer) n`);
    // db-await-in-loop: each scenario gets current statistics before the task is captured and replayed.
    await db.execute(sql`ANALYZE kept_transcript_deletions`);
    // db-await-in-loop: one measured task run per independently seeded history size.
    measurements.push({
      history,
      ...(await measureScheduledTaskReplay({
        openClient,
        label: "kept transcript deletion",
        task: fixtureRun,
        now,
      })),
    });
  }
  return measurements;
};
