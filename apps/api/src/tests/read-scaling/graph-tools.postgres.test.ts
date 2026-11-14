import { panic } from "better-result";
import { describe, expect, test } from "bun:test";

import { createTestState } from "@stll/test-state";

import { env } from "@/api/env";
import { LIST_VERIFICATION_FEATURE_ID } from "@/api/lib/feature-access/registry";
import { apiApp } from "@/api/server";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import type { GatedTestDb } from "@/api/tests/gated-test-database";
import { organizationFeatureGrants } from "@/api/tests/helpers/feature-grants";

import {
  graphToolsScalingScenarios,
  seedGraphToolsScaling,
} from "./graph-tools";
import { readScalingViolations } from "./measurement";

const testState = createTestState({ file: import.meta.path, config: env });

/** Every scenario on one fresh matter where `size` claims cite one fact. */
const measureAt = async (db: GatedTestDb, size: number) => {
  const fixture = await seedGraphToolsScaling({
    db,
    size,
    grantFeature: (organizationId) => {
      testState.setConfig("FEATURE_LEGAL_LISTS", true);
      testState.setConfig(
        "API_FEATURE_ACCESS_GRANTS",
        organizationFeatureGrants(organizationId, [
          LIST_VERIFICATION_FEATURE_ID,
        ]),
      );
    },
  });
  try {
    const measurements = [];
    for (const scenario of graphToolsScalingScenarios) {
      measurements.push(await scenario.measure(fixture));
    }
    return measurements;
  } finally {
    testState.setConfig("API_FEATURE_ACCESS_GRANTS", {});
    await fixture.cleanup();
  }
};

describe.skipIf(process.env["STELLA_RUN_POSTGRES_TESTS"] !== "true")(
  "graph tools scaling",
  () => {
    test("each graph tool pays the same round trips with 10 and 200 citing claims", async () => {
      const databaseUrl =
        process.env["DATABASE_URL"] ?? panic("DATABASE_URL required");
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const { db } = openClient({ max: 1 });
        const small = await measureAt(db, 10);
        const large = await measureAt(db, 200);
        for (const [index, scenario] of graphToolsScalingScenarios.entries()) {
          expect(
            apiApp.routes.some(
              ({ definition }) => definition === scenario.definition,
            ),
          ).toBe(true);
          const at10 = small.at(index) ?? panic(`${scenario.name}: unmeasured`);
          const at200 =
            large.at(index) ?? panic(`${scenario.name}: unmeasured`);
          console.info(
            "handler-scaling",
            JSON.stringify({ name: scenario.name, at10, at200 }),
          );
          expect(at10.rows).toBe(scenario.expectedRows);
          expect(at200.rows).toBe(scenario.expectedRows);
          expect(at10.statements).toBeGreaterThan(0);
          expect(readScalingViolations({ small: at10, large: at200 })).toEqual(
            [],
          );
        }
      });
    });
  },
);
