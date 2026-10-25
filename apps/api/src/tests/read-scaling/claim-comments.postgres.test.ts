import { panic } from "better-result";
import { describe, expect, test } from "bun:test";

import { env } from "@/api/env";
import { LIST_VERIFICATION_FEATURE_ID } from "@/api/lib/feature-access/registry";
import { apiApp } from "@/api/server";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import type { GatedTestDb } from "@/api/tests/gated-test-database";
import { organizationFeatureGrants } from "@/api/tests/helpers/feature-grants";
import { createTestState } from "@/api/tests/helpers/test-state";

import {
  claimCommentScalingScenarios,
  seedClaimCommentScaling,
} from "./claim-comments";
import { readScalingViolations } from "./measurement";

const testState = createTestState({ file: import.meta.path, config: env });

/** Every scenario on one fresh claim of `size` comments, list first. */
const measureAt = async (db: GatedTestDb, size: number) => {
  const fixture = await seedClaimCommentScaling({
    db,
    size,
    grantFeature: (organizationId) => {
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
    for (const scenario of claimCommentScalingScenarios) {
      measurements.push(await scenario.measure(fixture));
    }
    return measurements;
  } finally {
    testState.setConfig("API_FEATURE_ACCESS_GRANTS", {});
    await fixture.cleanup();
  }
};

describe.skipIf(process.env["STELLA_RUN_POSTGRES_TESTS"] !== "true")(
  "claim comment scaling",
  () => {
    test("each claim comment route pays the same round trips at 10 and 200 comments", async () => {
      const databaseUrl =
        process.env["DATABASE_URL"] ?? panic("DATABASE_URL required");
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const { db } = openClient({ max: 1 });
        const small = await measureAt(db, 10);
        const large = await measureAt(db, 200);
        for (const [
          index,
          scenario,
        ] of claimCommentScalingScenarios.entries()) {
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
          expect(at10.transactionRoundTrips).toBeGreaterThan(0);
          expect(readScalingViolations({ small: at10, large: at200 })).toEqual(
            [],
          );
        }
      });
    }, 120_000);
  },
);
