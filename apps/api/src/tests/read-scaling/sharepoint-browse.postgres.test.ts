import { panic } from "better-result";
import { describe, expect, test } from "bun:test";

import { createTestState } from "@stll/test-state";

import { apiRoutes } from "@/api/api-routes";
import { organizationSettings, sharepointConnections } from "@/api/db/schema";
import { env } from "@/api/env";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import { createScalingTempTables } from "@/api/tests/read-scaling/entity-fixture";
import { readScalingViolations } from "@/api/tests/read-scaling/measurement";
import {
  seedSharepointBrowseScaling,
  sharepointBrowseScalingScenarios,
} from "@/api/tests/read-scaling/sharepoint-browse";

const testState = createTestState({ file: import.meta.path, config: env });

describe.skipIf(process.env["STELLA_RUN_POSTGRES_TESTS"] !== "true")(
  "sharepoint browse scaling",
  () => {
    test("each browse read stays bounded as connected organizations grow", async () => {
      testState.setConfig("FEATURE_SHAREPOINT", true);
      const databaseUrl =
        process.env["DATABASE_URL"] ?? panic("DATABASE_URL required");
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const { db } = openClient({ max: 1 });
        await createScalingTempTables(db, [
          organizationSettings,
          sharepointConnections,
        ]);
        const fixtures = [];
        try {
          fixtures.push(await seedSharepointBrowseScaling(db, 10));
          fixtures.push(await seedSharepointBrowseScaling(db, 200));
          const small = fixtures.at(0) ?? panic("Small fixture required");
          const large = fixtures.at(1) ?? panic("Large fixture required");
          for (const scenario of sharepointBrowseScalingScenarios) {
            expect(
              apiRoutes.filter(
                ({ definition }) => definition === scenario.definition,
              ),
            ).toHaveLength(1);
            const at10 = await scenario.measure(small);
            const at200 = await scenario.measure(large);
            console.info(
              "handler-scaling",
              JSON.stringify({ name: scenario.name, at10, at200 }),
            );
            expect(at10.statements).toBeGreaterThan(0);
            expect(
              readScalingViolations({ small: at10, large: at200 }),
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
