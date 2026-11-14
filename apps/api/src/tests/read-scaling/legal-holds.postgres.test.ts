import { panic } from "better-result";
import { describe, expect, test } from "bun:test";

import { apiApp } from "@/api/server";
import { withGatedTestClients } from "@/api/tests/gated-test-database";

import { legalHoldScalingScenarios, seedLegalHoldScaling } from "./legal-holds";
import { writeScalingViolations } from "./measurement";

describe.skipIf(process.env["STELLA_RUN_POSTGRES_TESTS"] !== "true")(
  "legal hold write scaling",
  () => {
    test("placement and release have fixed work at 10 and 200 existing holds", async () => {
      const databaseUrl =
        process.env["DATABASE_URL"] ?? panic("DATABASE_URL required");
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const { db } = openClient();
        const small = await seedLegalHoldScaling(db, 10);
        const large = await seedLegalHoldScaling(db, 200);
        try {
          for (const scenario of legalHoldScalingScenarios) {
            expect(
              apiApp.routes.some(
                ({ definition }) => definition === scenario.definition,
              ),
            ).toBe(true);
            const at10 = await scenario.measure(small);
            const at200 = await scenario.measure(large);
            expect(at10.statements).toBeGreaterThan(0);
            expect(at10.transactionRoundTrips).toBeGreaterThan(0);
            expect(
              writeScalingViolations({ small: at10, large: at200 }),
            ).toEqual([]);
          }
        } finally {
          await small.cleanup();
          await large.cleanup();
        }
      });
    });
  },
);
