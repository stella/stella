import { panic } from "better-result";
import { describe, expect, test } from "bun:test";

import { withGatedTestClients } from "@/api/tests/gated-test-database";

import { readScalingViolations } from "./measurement";
import {
  seedTimeEntryReportScaling,
  timeEntryReportScalingScenario,
} from "./time-entry-report";

describe.skipIf(process.env["STELLA_RUN_POSTGRES_TESTS"] !== "true")(
  "team time report scaling",
  () => {
    test("keeps statements, transactions and returned buckets fixed at 10 and 200 entries", async () => {
      const url = process.env["DATABASE_URL"] ?? panic("DATABASE_URL required");
      await withGatedTestClients(url, async ({ openClient }) => {
        const { db } = openClient({ max: 1 });
        const measure = async (size: number) => {
          const fixture = await seedTimeEntryReportScaling(db, size);
          try {
            return await timeEntryReportScalingScenario.measure(fixture);
          } finally {
            await fixture.cleanup();
          }
        };
        const small = await measure(10);
        const large = await measure(200);
        expect(small.rows).toBe(1);
        expect(large.rows).toBe(1);
        expect(small.statements).toBeGreaterThan(0);
        expect(small.transactionRoundTrips).toBeGreaterThan(0);
        expect(readScalingViolations({ small, large })).toEqual([]);
        console.info(
          "handler-scaling",
          JSON.stringify({
            name: timeEntryReportScalingScenario.name,
            at10: small,
            at200: large,
          }),
        );
      });
    }, 120_000); // timeout: seeds and measures two real PostgreSQL populations
  },
);
