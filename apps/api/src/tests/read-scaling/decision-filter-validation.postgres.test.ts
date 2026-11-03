import { panic } from "better-result";
import { describe, expect, test } from "bun:test";

import { createDecisionFilterValidationRoute } from "@/api/handlers/case-law/decisions/filter-validation";
import { withGatedTestClients } from "@/api/tests/gated-test-database";

import { decisionFilterValidationScalingScenario } from "./decision-filter-validation";
import { readScalingViolations } from "./measurement";

describe.skipIf(process.env["STELLA_RUN_POSTGRES_TESTS"] !== "true")(
  "public decision filter validation scaling",
  () => {
    test("keeps membership reads bounded as the corpus grows", async () => {
      const databaseUrl =
        process.env["DATABASE_URL"] ?? panic("DATABASE_URL required");
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const small = await decisionFilterValidationScalingScenario.measure({
          size: 10,
          db: openClient().db,
          createHandler: createDecisionFilterValidationRoute,
        });
        const large = await decisionFilterValidationScalingScenario.measure({
          size: 200,
          db: openClient().db,
          createHandler: createDecisionFilterValidationRoute,
        });
        console.info(
          "handler-scaling",
          JSON.stringify({
            name: decisionFilterValidationScalingScenario.name,
            at10: small,
            at200: large,
          }),
        );
        expect(small.rows).toBe(1);
        expect(large.rows).toBe(1);
        expect(small.statements).toBeGreaterThan(0);
        expect(small.transactionRoundTrips).toBeGreaterThan(0);
        expect(readScalingViolations({ small, large })).toEqual([]);
      });
    });
  },
);
