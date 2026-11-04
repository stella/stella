import { panic } from "better-result";
import { describe, expect, test } from "bun:test";

import { apiApp } from "@/api/server";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import type { GatedTestDb } from "@/api/tests/gated-test-database";

import {
  legislationMatterLinkScalingScenarios,
  seedLegislationMatterLinkScaling,
} from "./legislation-matter-links";
import { readScalingViolations } from "./measurement";

const measureAt = async (db: GatedTestDb, size: number) => {
  const fixture = await seedLegislationMatterLinkScaling(db, size);
  try {
    const measurements = [];
    for (const scenario of legislationMatterLinkScalingScenarios) {
      measurements.push(await scenario.measure(fixture));
    }
    return measurements;
  } finally {
    await fixture.cleanup();
  }
};

describe.skipIf(process.env["STELLA_RUN_POSTGRES_TESTS"] !== "true")(
  "legislation matter link scaling",
  () => {
    test("all routes keep fixed database round trips as other matters grow from 10 to 200 links", async () => {
      const databaseUrl =
        process.env["DATABASE_URL"] ?? panic("DATABASE_URL required");
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const { db } = openClient({ max: 1 });
        const small = await measureAt(db, 10);
        const large = await measureAt(db, 200);
        for (const [
          index,
          scenario,
        ] of legislationMatterLinkScalingScenarios.entries()) {
          expect(
            apiApp.routes.some(
              ({ definition }) => definition === scenario.definition,
            ),
          ).toBe(true);
          const at10 = small.at(index) ?? panic(`${scenario.name}: unmeasured`);
          const at200 =
            large.at(index) ?? panic(`${scenario.name}: unmeasured`);
          expect(at10.rows).toBe(scenario.expectedRows);
          expect(at200.rows).toBe(scenario.expectedRows);
          expect(at10.statements).toBeGreaterThan(0);
          expect(at10.transactionRoundTrips).toBeGreaterThan(0);
          expect(readScalingViolations({ small: at10, large: at200 })).toEqual(
            [],
          );
        }
      });
    }, 120_000); // timeout: seeds and measures eight real transactional handler calls, then removes both tenant fixtures.
  },
);
