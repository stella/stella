import { panic } from "better-result";
import { describe, expect, test } from "bun:test";

import { withGatedTestClients } from "@/api/tests/gated-test-database";

import { readScalingViolations } from "./measurement";
import {
  softLawReadScalingScenario,
  softLawSearchScalingScenario,
} from "./soft-law";

describe.skipIf(process.env["STELLA_RUN_POSTGRES_TESTS"] !== "true")(
  "regulator guidance scaling",
  () => {
    test.each([
      [softLawSearchScalingScenario, 10],
      [softLawReadScalingScenario, 1],
    ] as const)(
      "$name stays bounded as the corpus grows",
      async (scenario, rows) => {
        const databaseUrl =
          process.env["DATABASE_URL"] ?? panic("DATABASE_URL required");
        await withGatedTestClients(databaseUrl, async ({ openClient }) => {
          const { db } = openClient({ max: 1 });
          const small = await scenario.measure({ size: 10, db });
          const large = await scenario.measure({ size: 200, db });
          console.info(
            "handler-scaling",
            JSON.stringify({ name: scenario.name, at10: small, at200: large }),
          );
          expect(small.rows).toBe(rows);
          expect(large.rows).toBe(rows);
          expect(small.statements).toBeGreaterThan(0);
          expect(small.transactionRoundTrips).toBeGreaterThan(0);
          expect(readScalingViolations({ small, large })).toEqual([]);
        });
      },
    );
  },
);
