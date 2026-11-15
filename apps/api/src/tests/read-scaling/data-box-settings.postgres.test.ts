import { panic } from "better-result";
import { describe, expect, test } from "bun:test";

import { apiRoutes } from "@/api/api-routes";
import { organizationSettings } from "@/api/db/schema";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import {
  dataBoxSettingsScalingScenarios,
  seedDataBoxSettingsScaling,
} from "@/api/tests/read-scaling/data-box-settings";
import { createScalingTempTables } from "@/api/tests/read-scaling/entity-fixture";
import {
  readScalingViolations,
  writeScalingViolations,
} from "@/api/tests/read-scaling/measurement";

describe.skipIf(process.env["STELLA_RUN_POSTGRES_TESTS"] !== "true")(
  "organization data-box settings scaling",
  () => {
    test("all three mounted handlers remain bounded across tenant cardinalities", async () => {
      const databaseUrl =
        process.env["DATABASE_URL"] ?? panic("DATABASE_URL required");
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const { db } = openClient({ max: 1 });
        await createScalingTempTables(db, [organizationSettings]);
        const fixtures = [];
        try {
          fixtures.push(await seedDataBoxSettingsScaling(db, 10));
          fixtures.push(await seedDataBoxSettingsScaling(db, 200));
          const small =
            fixtures.at(0) ?? panic("Small settings fixture required");
          const large =
            fixtures.at(1) ?? panic("Large settings fixture required");
          for (const scenario of dataBoxSettingsScalingScenarios) {
            const mounted = apiRoutes.filter(
              ({ definition }) => definition === scenario.definition,
            );
            expect(mounted).toHaveLength(1);
            const at10 = await scenario.measure(small);
            const at200 = await scenario.measure(large);
            console.info(
              "handler-scaling",
              JSON.stringify({ name: scenario.name, at10, at200 }),
            );
            expect(at10.statements).toBeGreaterThan(0);
            expect(at10.transactionRoundTrips).toBeGreaterThan(0);
            expect(
              readScalingViolations({ small: at10, large: at200 }),
            ).toEqual([]);
            expect(
              writeScalingViolations({ small: at10, large: at200 }),
            ).toEqual([]);
          }
        } finally {
          for (const fixture of fixtures) {
            await fixture.cleanup();
          }
        }
      });
    });
  },
);
