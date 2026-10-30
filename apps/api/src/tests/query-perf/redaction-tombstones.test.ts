import { panic } from "better-result";
import { describe, expect, test } from "bun:test";

import {
  BACKFILL_CASE_LAW_REDACTION_TOMBSTONES_TASK,
  REDACTION_TOMBSTONE_BACKFILL_JOB_ID,
} from "@/api/lib/scheduler/tasks/case-law-redaction-tombstone-backfill";

import { withQueryPerfFixture } from "./fixture";
import { budgetProblem, scaleViolations } from "./measurement";
import {
  redactionTombstonePageCompleted,
  seedRedactionTombstoneScenario,
} from "./redaction-tombstone-seed";
import { measureScheduledJobRun } from "./scheduled-run";

const enabled = process.env["STELLA_RUN_QUERY_PERF_TESTS"] === "true";

describe.skipIf(!enabled)("redaction tombstone read budget (postgres)", () => {
  // timeout: clone creation, two bulk seeds and EXPLAIN runs share the fixture's 300-second deadline.
  test.each(["repair", "inline-raw", "settled"] as const)(
    "measures the full bounded %s page at both corpus sizes",
    async (cohort) => {
      await withQueryPerfFixture({
        databaseUrl:
          process.env["DATABASE_URL"] ?? panic("Missing PostgreSQL test URL"),
        profileId: "redaction",
        timeoutMs: 300_000,
        run: async (database) => {
          const measurements = [];
          for (const rows of [60_000, 120_000]) {
            // db-await-in-loop: each population starts from the same unprocessed audit page.
            await seedRedactionTombstoneScenario(database, {
              type: "redaction-tombstones",
              cohort,
              rows,
            });
            // db-await-in-loop: measure the registered task at each independent population size.
            const measured = await measureScheduledJobRun({
              database,
              jobId: REDACTION_TOMBSTONE_BACKFILL_JOB_ID,
              task: BACKFILL_CASE_LAW_REDACTION_TOMBSTONES_TASK,
            });
            expect(measured.planViolations).toEqual([]);
            expect(
              budgetProblem(
                "scheduled.caseLaw.redactionTombstones.v3",
                measured.metrics,
              ),
            ).toBeUndefined();
            // db-await-in-loop: the assertion observes committed work before reseeding the next population.
            expect(await redactionTombstonePageCompleted(database)).toBe(true);
            expect(
              measured.statements.some(({ statement }) =>
                statement.startsWith(
                  'update "case_law_decisions" set "source_raw"',
                ),
              ),
            ).toBe(true);
            measurements.push(measured.metrics.sharedBlocks);
            console.info(
              "redaction-tombstone-read-budget",
              JSON.stringify({
                cohort,
                rows,
                ...measured.metrics,
                statements: measured.statements,
              }),
            );
          }
          const [size, double] = measurements;
          if (size === undefined || double === undefined) {
            return panic("Missing redaction measurements");
          }
          expect(scaleViolations({ size, double })).toEqual([]);
        },
      });
    },
    300_000,
  );
});
