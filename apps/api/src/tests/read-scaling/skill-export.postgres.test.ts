import { panic } from "better-result";
import { describe, expect, test } from "bun:test";

import { apiApp } from "@/api/server";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import { startFakeS3 } from "@/api/tests/helpers/fake-s3";
import { readScalingViolations } from "@/api/tests/read-scaling/measurement";
import {
  seedSkillExportScaling,
  skillExportScalingScenarios,
} from "@/api/tests/read-scaling/skill-export";

describe.skipIf(process.env["STELLA_RUN_POSTGRES_TESTS"] !== "true")(
  "skill export read scaling",
  () => {
    test("the skill export keeps queries and response bytes bounded at 10 and 200 files", async () => {
      const databaseUrl =
        process.env["DATABASE_URL"] ?? panic("DATABASE_URL required");
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const { db } = openClient();
        const storage = startFakeS3();
        const fixtures: Awaited<ReturnType<typeof seedSkillExportScaling>>[] =
          [];
        const cleanupFailures: unknown[] = [];
        try {
          const small = await seedSkillExportScaling(db, 10);
          fixtures.push(small);
          const large = await seedSkillExportScaling(db, 200);
          fixtures.push(large);
          for (const scenario of skillExportScalingScenarios) {
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
          // Each fixture is cleaned up even when another's cleanup fails, and
          // fake storage stops either way.
          for (const fixture of fixtures) {
            await fixture.cleanup().catch((error: unknown) => {
              cleanupFailures.push(error);
            });
          }
          storage.stop();
        }
        expect(cleanupFailures).toEqual([]);
      });
    });
  },
);
