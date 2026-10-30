import { expect, test } from "bun:test";

import { apiApp } from "@/api/server";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import { withIsolatedPostgresCluster } from "@/api/tests/isolated-postgres-cluster";

import { writeScalingViolations } from "./measurement";
import { sharepointCapabilitiesScalingScenario as scenario } from "./sharepoint-capabilities";

test("delegated capability writes stay bounded as stored connections grow", async () => {
  expect(
    apiApp.routes.some(({ definition }) => definition === scenario.definition),
  ).toBe(true);
  await withIsolatedPostgresCluster(
    {
      prefix: "capability-scaling",
      database: "stella",
      user: "fixture",
      password: "fixture",
    },
    async (databaseUrl) => {
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const { db } = openClient({ max: 1 });
        await scenario.prepare(db);
        const small = await scenario.seed(db, 10);
        const large = await scenario.seed(db, 200);
        try {
          const at10 = await scenario.measure(small);
          const at200 = await scenario.measure(large);
          expect(at10.statements).toBeGreaterThan(0);
          expect(at10.transactionRoundTrips).toBeGreaterThan(0);
          expect(writeScalingViolations({ small: at10, large: at200 })).toEqual(
            [],
          );
        } finally {
          await small.cleanup();
          await large.cleanup();
        }
      });
    },
  );
});
