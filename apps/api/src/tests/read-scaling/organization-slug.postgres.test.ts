import { panic } from "better-result";
import { describe, expect, test } from "bun:test";

import { apiApp } from "@/api/server";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import type { GatedTestDb } from "@/api/tests/gated-test-database";

import { writeScalingViolations } from "./measurement";
import { organizationSlugScalingScenario } from "./organization-slug";

const measureAt = async (db: GatedTestDb, size: number) => {
  const fixture = await organizationSlugScalingScenario.seed(db, size);
  try {
    return await organizationSlugScalingScenario.measure(fixture);
  } finally {
    await fixture.cleanup();
  }
};

describe.skipIf(process.env["STELLA_RUN_POSTGRES_TESTS"] !== "true")(
  "organization slug write scaling",
  () => {
    test("changing one slug keeps database work and response size fixed at 10 and 200 organizations and members", async () => {
      const databaseUrl =
        process.env["DATABASE_URL"] ?? panic("DATABASE_URL required");
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const { db } = openClient({ max: 1 });

        expect(
          apiApp.routes.some(
            ({ definition }) =>
              definition === organizationSlugScalingScenario.definition,
          ),
        ).toBe(true);
        const at10 = await measureAt(db, 10);
        const at200 = await measureAt(db, 200);
        console.info(
          "handler-scaling",
          JSON.stringify({
            name: organizationSlugScalingScenario.name,
            at10,
            at200,
          }),
        );
        expect(at10.rows).toBe(1);
        expect(at200.rows).toBe(1);
        expect(at10.statements).toBeGreaterThan(0);
        expect(at10.transactionRoundTrips).toBeGreaterThan(0);
        expect(writeScalingViolations({ small: at10, large: at200 })).toEqual(
          [],
        );
      });
    }, 120_000); // timeout: seeds and mutates organization data at two cardinalities in real PostgreSQL
  },
);
