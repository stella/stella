import { panic } from "better-result";
import { describe, expect, test } from "bun:test";

import { createTestState } from "@stll/test-state";

import { apiRoutes } from "@/api/api-routes";
import { dictationLearnedFixes } from "@/api/db/schema";
import { desktopDeviceProofReplays } from "@/api/db/schema/desktop-device-proof-replay";
import { env } from "@/api/env";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import {
  learnedFixesScalingScenarios,
  seedLearnedFixesScaling,
} from "@/api/tests/read-scaling/dictation-learned-fixes";
import { createScalingTempTables } from "@/api/tests/read-scaling/entity-fixture";
import { readScalingViolations } from "@/api/tests/read-scaling/measurement";

const testState = createTestState({ file: import.meta.path, config: env });

describe.skipIf(process.env["STELLA_RUN_POSTGRES_TESTS"] !== "true")(
  "learned dictation fixes scaling",
  () => {
    test("both mounted reads stay bounded as colleagues and other organizations keep fixes", async () => {
      const databaseUrl =
        process.env["DATABASE_URL"] ?? panic("DATABASE_URL required");
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const { db } = openClient({ max: 1 });
        await createScalingTempTables(db, [
          dictationLearnedFixes,
          desktopDeviceProofReplays,
        ]);
        const fixtures = [];
        try {
          fixtures.push(await seedLearnedFixesScaling(db, 10));
          fixtures.push(await seedLearnedFixesScaling(db, 200));
          const small =
            fixtures.at(0) ?? panic("Small learned-fix fixture required");
          const large =
            fixtures.at(1) ?? panic("Large learned-fix fixture required");
          testState.patchConfig({
            FEATURE_ORG_ACCESS_STATE: true,
            FEATURE_CONFIGURED_ACCESS: false,
            FEATURE_FREE_TIER: false,
          });
          for (const scenario of learnedFixesScalingScenarios) {
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
            expect(at10.transactionRoundTrips).toBeGreaterThan(0);
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
