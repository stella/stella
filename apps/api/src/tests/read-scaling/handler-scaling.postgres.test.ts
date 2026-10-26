import { panic } from "better-result";
import { describe, expect, test } from "bun:test";

import { env } from "@/api/env";
import { apiApp } from "@/api/server";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import { createTestState } from "@/api/tests/helpers/test-state";
import {
  prepareEntityReadScalingTables,
  seedEntityReadScaling,
} from "@/api/tests/read-scaling/entity-fixture";
import {
  readScalingViolations,
  writeScalingViolations,
} from "@/api/tests/read-scaling/measurement";
import { readScalingScenarios } from "@/api/tests/read-scaling/scenarios";
import { writeScalingScenarios } from "@/api/tests/read-scaling/write-scenarios";

const testState = createTestState({ file: import.meta.path, config: env });

describe.skipIf(process.env["STELLA_RUN_POSTGRES_TESTS"] !== "true")(
  "registered handler scaling",
  () => {
    test("every registered case measures production handlers at both cardinalities", async () => {
      const databaseUrl =
        process.env["DATABASE_URL"] ?? panic("DATABASE_URL required");
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const { db } = openClient({ max: 1 });
        await prepareEntityReadScalingTables(db);
        const small = await seedEntityReadScaling(db, 10);
        const large = await seedEntityReadScaling(db, 200);
        try {
          testState.setConfig("FEATURE_TIME_BILLING", true);
          testState.setConfig("API_FEATURE_ACCESS_GRANTS", {
            ...env.API_FEATURE_ACCESS_GRANTS,
            "activity-timeline": [
              { type: "organization", organizationId: small.organizationId },
              { type: "organization", organizationId: large.organizationId },
            ],
          });
          for (const scenario of readScalingScenarios) {
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
          await small.cleanup();
          await large.cleanup();
        }
      });
    }, 120_000);

    test("every registered write pays the same round trips at both data sizes", async () => {
      const databaseUrl =
        process.env["DATABASE_URL"] ?? panic("DATABASE_URL required");
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const { db } = openClient({ max: 1 });
        for (const scenario of writeScalingScenarios) {
          expect(
            apiApp.routes.some(
              ({ definition }) => definition === scenario.definition,
            ),
          ).toBe(true);
          await scenario.prepare(db);
          const small = await scenario.seed(db, 10);
          const large = await scenario.seed(db, 200);
          try {
            const at10 = await scenario.measure(small);
            const at200 = await scenario.measure(large);
            console.info(
              "handler-scaling",
              JSON.stringify({ name: scenario.name, at10, at200 }),
            );
            expect(
              writeScalingViolations({ small: at10, large: at200 }),
            ).toEqual([]);
          } finally {
            await small.cleanup();
            await large.cleanup();
          }
        }
      });
    }, 120_000);
  },
);
