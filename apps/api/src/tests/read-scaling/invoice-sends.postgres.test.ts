import { panic } from "better-result";
import { describe, expect, test } from "bun:test";

import { apiApp } from "@/api/server";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import type { GatedTestDb } from "@/api/tests/gated-test-database";

import {
  invoiceSendScalingScenarios,
  seedInvoiceSendScaling,
} from "./invoice-sends";
import { readScalingViolations, writeScalingViolations } from "./measurement";

const measureAt = async (db: GatedTestDb, size: number) => {
  const fixture = await seedInvoiceSendScaling(db, size);
  try {
    const measurements = [];
    for (const scenario of invoiceSendScalingScenarios) {
      measurements.push(await scenario.measure(fixture));
    }
    return measurements;
  } finally {
    await fixture.cleanup();
  }
};

describe.skipIf(process.env["STELLA_RUN_POSTGRES_TESTS"] !== "true")(
  "invoice send scaling",
  () => {
    test("send handlers keep their database work and response size fixed at 10 and 200 invoices", async () => {
      const databaseUrl =
        process.env["DATABASE_URL"] ?? panic("DATABASE_URL required");
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const { db } = openClient({ max: 1 });
        const small = await measureAt(db, 10);
        const large = await measureAt(db, 200);
        for (const [index, scenario] of invoiceSendScalingScenarios.entries()) {
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
          const measurements = { small: at10, large: at200 };
          switch (scenario.type) {
            case "read":
              expect(readScalingViolations(measurements)).toEqual([]);
              break;
            case "write":
              expect(writeScalingViolations(measurements)).toEqual([]);
              break;
            default:
              scenario satisfies never;
          }
        }
      });
    }, 120_000); // timeout: seeds and exercises scoped send handlers against two real PostgreSQL populations
  },
);
