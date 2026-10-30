import { panic } from "better-result";
import { describe, expect, test } from "bun:test";

import { READ_BUDGETS } from "@/api/lib/db/read-budgets";

import { withQueryPerfFixture } from "./fixture";
import {
  budgetProblem,
  measureQueryPerf,
  scaleViolations,
} from "./measurement";
import { QUERY_PERF_PROFILES } from "./profiles";
import { queryPerfRegistry } from "./registry";
import { seedQueryPerf } from "./seed";

const enabled =
  process.env["STELLA_RUN_QUERY_PERF_TESTS"] === "true" &&
  Boolean(process.env["DATABASE_URL"]);
const budgetId = "statement.billingDrafts.candidateMatters";

describe.skipIf(!enabled)(
  "billing candidate matter read budget under RLS",
  () => {
    test("90-day candidate probes stay bounded at both sizes and reject historical organization scans", async () => {
      const measurements: number[] = [];
      for (const profileId of QUERY_PERF_PROFILES) {
        await withQueryPerfFixture({
          databaseUrl:
            process.env["DATABASE_URL"] ?? panic("PostgreSQL URL required"),
          profileId,
          run: async (db, deadline) => {
            const seed = await deadline.run(
              "seed candidate history",
              async () => await seedQueryPerf(db, profileId),
            );
            const entry =
              queryPerfRegistry(seed).find(
                (item) => item.budgetId === budgetId,
              ) ?? panic("Candidate budget is unregistered");
            const good = await measureQueryPerf({
              database: db,
              seed,
              query: entry.query,
              owner: budgetId,
              ownerDeadlineMs: entry.ownerDeadlineMs,
              profileId,
            });
            const bad = await measureQueryPerf({
              database: db,
              seed,
              query: seed.billingDraftUnboundedCandidates,
              owner: budgetId,
              ownerDeadlineMs: entry.ownerDeadlineMs,
              profileId,
            });
            console.info(
              JSON.stringify({
                event: "billing_candidate_read_budget",
                profileId,
                budgetId,
                budgetPages: READ_BUDGETS[budgetId].pages,
                bounded: good.metrics,
                unbounded: bad.metrics,
                boundedPlan: good.plan.Plan,
                unboundedPlan: bad.plan.Plan,
              }),
            );
            measurements.push(good.metrics.sharedBlocks);
            expect(good.plan.Plan["Actual Rows"]).toBe(1);
            expect(bad.plan.Plan["Actual Rows"]).toBe(1);
            expect(good.planViolations).toEqual([]);
            expect(budgetProblem(budgetId, good.metrics)).toBeUndefined();
            if (profileId === "growth") {
              expect(budgetProblem(budgetId, bad.metrics)).toContain("shared");
            }
          },
        });
      }
      expect(measurements).toHaveLength(2);
      expect(
        scaleViolations({
          size: measurements.at(0) ?? panic("Missing small plan"),
          double: measurements.at(1) ?? panic("Missing growth plan"),
        }),
      ).toEqual([]);
    }, 330_000); // timeout: two isolated tenant fixtures, historical seeds and warm-cache RLS plans.
  },
);
