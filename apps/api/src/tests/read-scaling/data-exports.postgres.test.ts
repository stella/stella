import { panic } from "better-result";
import { describe, expect, test } from "bun:test";

import { apiApp } from "@/api/server";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import { startFakeS3 } from "@/api/tests/helpers/fake-s3";
import {
  dataExportReadScalingScenarios,
  seedDataExportReadScaling,
} from "@/api/tests/read-scaling/data-exports";
import { readScalingViolations } from "@/api/tests/read-scaling/measurement";

describe.skipIf(process.env["STELLA_RUN_POSTGRES_TESTS"] !== "true")(
  "organization export read scaling",
  () => {
    test("mounted export readers keep queries and projected bytes bounded at both cardinalities", async () => {
      const databaseUrl =
        process.env["DATABASE_URL"] ?? panic("DATABASE_URL required");
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const { db } = openClient();
        const storage = startFakeS3();
        const fixtures: Awaited<
          ReturnType<typeof seedDataExportReadScaling>
        >[] = [];
        try {
          const small = await seedDataExportReadScaling(db, 10);
          fixtures.push(small);
          const large = await seedDataExportReadScaling(db, 200);
          fixtures.push(large);
          for (const scenario of dataExportReadScalingScenarios) {
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
          try {
            for (const fixture of fixtures) {
              await fixture.cleanup();
            }
          } finally {
            storage.stop();
          }
        }
      });
    });
  },
);
