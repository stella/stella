import { panic } from "better-result";
import { describe, expect, test } from "bun:test";

import { createCheckCitation } from "@/api/handlers/case-law/citations/check";
import { withGatedTestClients } from "@/api/tests/gated-test-database";

import { citationCheckApiScalingScenario } from "./citation-check";
import {
  prepareEntityReadScalingTables,
  seedEntityReadScaling,
} from "./entity-fixture";
import { readScalingViolations } from "./measurement";

describe.skipIf(process.env["STELLA_RUN_POSTGRES_TESTS"] !== "true")(
  "editor citation check scaling",
  () => {
    test("keeps the identity and text reads bounded as the corpus grows", async () => {
      const databaseUrl =
        process.env["DATABASE_URL"] ?? panic("DATABASE_URL required");
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const { db } = openClient({ max: 1 });
        await prepareEntityReadScalingTables(db);
        const small = await seedEntityReadScaling(db, 10);
        const large = await seedEntityReadScaling(db, 200);
        try {
          const at10 = await citationCheckApiScalingScenario.measure(
            small,
            createCheckCitation,
          );
          const at200 = await citationCheckApiScalingScenario.measure(
            large,
            createCheckCitation,
          );
          console.info(
            "handler-scaling",
            JSON.stringify({
              name: citationCheckApiScalingScenario.name,
              at10,
              at200,
            }),
          );
          expect(at10.rows).toBe(1);
          expect(at200.rows).toBe(1);
          expect(at10.statements).toBeGreaterThan(0);
          expect(at10.transactionRoundTrips).toBeGreaterThan(0);
          expect(readScalingViolations({ small: at10, large: at200 })).toEqual(
            [],
          );
        } finally {
          await small.cleanup();
          await large.cleanup();
        }
      });
    });
  },
);
