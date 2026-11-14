import { panic } from "better-result";
import { describe, expect, test } from "bun:test";

import { createTestState } from "@stll/test-state";

import { env } from "@/api/env";
import { LIST_VERIFICATION_FEATURE_ID } from "@/api/lib/feature-access/registry";
import { apiApp } from "@/api/server";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import type { GatedTestDb } from "@/api/tests/gated-test-database";
import { organizationFeatureGrants } from "@/api/tests/helpers/feature-grants";

import { readScalingViolations } from "./measurement";
import {
  CHRONOLOGY_LIST_DOCUMENTS,
  seedVerificationGraphScaling,
  verificationChronologyScalingScenarios,
  verificationGraphScalingScenarios,
} from "./verification-graph";
import type { VerificationGraphScalingFixture } from "./verification-graph";

const testState = createTestState({ file: import.meta.path, config: env });

type Scenario = {
  name: string;
  expectedRows: number;
  definition: unknown;
  measure: (fixture: VerificationGraphScalingFixture) => Promise<{
    statements: number;
    transactionRoundTrips: number;
    responseBytes: number;
    rows: number;
  }>;
};

/** Every scenario on one fresh matter where `size` documents were verified,
 *  `listDocuments` of them against the measured list. */
const measureAt = async ({
  db,
  size,
  listDocuments,
  scenarios,
}: {
  db: GatedTestDb;
  size: number;
  listDocuments?: number;
  scenarios: readonly Scenario[];
}) => {
  const fixture = await seedVerificationGraphScaling({
    db,
    size,
    ...(listDocuments === undefined ? {} : { listDocuments }),
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
    for (const scenario of scenarios) {
      measurements.push(await scenario.measure(fixture));
    }
    return measurements;
  } finally {
    testState.setConfig("API_FEATURE_ACCESS_GRANTS", {});
    await fixture.cleanup();
  }
};

const expectFlat = ({
  scenarios,
  small,
  large,
}: {
  scenarios: readonly Scenario[];
  small: Awaited<ReturnType<typeof measureAt>>;
  large: Awaited<ReturnType<typeof measureAt>>;
}) => {
  for (const [index, scenario] of scenarios.entries()) {
    expect(
      apiApp.routes.some(
        ({ definition }) => definition === scenario.definition,
      ),
    ).toBe(true);
    const at10 = small.at(index) ?? panic(`${scenario.name}: unmeasured`);
    const at200 = large.at(index) ?? panic(`${scenario.name}: unmeasured`);
    console.info(
      "handler-scaling",
      JSON.stringify({ name: scenario.name, at10, at200 }),
    );
    expect(at10.rows).toBe(scenario.expectedRows);
    expect(at200.rows).toBe(scenario.expectedRows);
    expect(at10.statements).toBeGreaterThan(0);
    expect(at10.transactionRoundTrips).toBeGreaterThan(0);
    expect(readScalingViolations({ small: at10, large: at200 })).toEqual([]);
  }
};

describe.skipIf(process.env["STELLA_RUN_POSTGRES_TESTS"] !== "true")(
  "verification graph scaling",
  () => {
    // timeout: seeds and measures two lists of up to 200 verified documents on a real database.
    test("a graph page pays the same round trips at 10 and 200 verified documents", async () => {
      const databaseUrl =
        process.env["DATABASE_URL"] ?? panic("DATABASE_URL required");
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const { db } = openClient({ max: 1 });
        const scenarios = verificationGraphScalingScenarios;
        const small = await measureAt({ db, size: 10, scenarios });
        const large = await measureAt({ db, size: 200, scenarios });
        expectFlat({ scenarios, small, large });
      });
    }, 120_000);

    // timeout: seeds and measures two matters of up to 200 verified documents on a real database.
    test("a chronology export pays the same round trips however many documents the matter verified against other lists", async () => {
      const databaseUrl =
        process.env["DATABASE_URL"] ?? panic("DATABASE_URL required");
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const { db } = openClient({ max: 1 });
        const scenarios = verificationChronologyScalingScenarios;
        const listDocuments = CHRONOLOGY_LIST_DOCUMENTS;
        const small = await measureAt({
          db,
          size: 10,
          listDocuments,
          scenarios,
        });
        const large = await measureAt({
          db,
          size: 200,
          listDocuments,
          scenarios,
        });
        expectFlat({ scenarios, small, large });
      });
    }, 120_000);
  },
);
