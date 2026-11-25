import { panic } from "better-result";
import { describe, expect, test } from "bun:test";

import { apiApp } from "@/api/server";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import { readScalingViolations } from "@/api/tests/read-scaling/measurement";
import {
  seedSkillMonitorScaling,
  skillMonitorScalingScenarios,
} from "@/api/tests/read-scaling/skill-monitor";

describe.skipIf(process.env["STELLA_RUN_POSTGRES_TESTS"] !== "true")(
  "skill monitor read scaling",
  () => {
    test("the skill monitor keeps queries and response bytes bounded at 10 and 200 access rows", async () => {
      const databaseUrl =
        process.env["DATABASE_URL"] ?? panic("DATABASE_URL required");
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const { db } = openClient();
        const fixtures: Awaited<ReturnType<typeof seedSkillMonitorScaling>>[] =
          [];
        const cleanupFailures: unknown[] = [];
        try {
          const small = await seedSkillMonitorScaling(db, 10);
          fixtures.push(small);
          const large = await seedSkillMonitorScaling(db, 200);
          fixtures.push(large);
          for (const scenario of skillMonitorScalingScenarios) {
            expect(
              apiApp.routes.some(
                ({ definition }) => definition === scenario.definition,
              ),
            ).toBe(true);
            const at10 = await scenario.measure(small);
            const at200 = await scenario.measure(large);
            console.info(
              "handler-scaling",
              JSON.stringify({ name: scenario.name, at10, at200 }),
            );
            expect(at10.rows).toBe(scenario.expectedRows);
            expect(at200.rows).toBe(scenario.expectedRows);
            expect(at10.statements).toBeGreaterThan(0);
            expect(at10.transactionRoundTrips).toBeGreaterThan(0);
            expect(
              readScalingViolations({ small: at10, large: at200 }),
            ).toEqual([]);
          }
        } finally {
          for (const fixture of fixtures) {
            await fixture.cleanup().catch((error: unknown) => {
              cleanupFailures.push(error);
            });
          }
        }
        expect(cleanupFailures).toEqual([]);
      });
    });
  },
);
