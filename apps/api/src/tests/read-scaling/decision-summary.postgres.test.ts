import { panic } from "better-result";
import { describe, expect, test } from "bun:test";

import { createReadDecisionSummaryHandler } from "@/api/handlers/case-law/decisions/summary/get";
import { withGatedTestClients } from "@/api/tests/gated-test-database";

import { decisionSummaryScalingScenario } from "./decision-summary";
import { readScalingViolations } from "./measurement";

describe.skipIf(process.env["STELLA_RUN_POSTGRES_TESTS"] !== "true")(
  "public decision summary scaling",
  () => {
    test("keeps the gated summary read bounded as the corpus grows", async () => {
      const databaseUrl =
        process.env["DATABASE_URL"] ?? panic("DATABASE_URL required");
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const small = await decisionSummaryScalingScenario.measure({
          size: 10,
          db: openClient().db,
          createHandler: createReadDecisionSummaryHandler,
        });
        const large = await decisionSummaryScalingScenario.measure({
          size: 200,
          db: openClient().db,
          createHandler: createReadDecisionSummaryHandler,
        });
        console.info(
          "handler-scaling",
          JSON.stringify({
            name: decisionSummaryScalingScenario.name,
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
