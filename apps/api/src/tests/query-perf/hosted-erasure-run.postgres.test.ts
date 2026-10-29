import { panic } from "better-result";
import { describe, expect, test } from "bun:test";

import { withQueryPerfFixture } from "./fixture";
import { measureHostedErasureHistory } from "./hosted-erasure-run";
import { budgetProblem, scaleViolations } from "./measurement";

const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

describe.skipIf(!enabled)("scheduled erasure read cost (postgres)", () => {
  test("a fixed work batch reads bounded pages independent of retained history", async () => {
    const url = process.env["DATABASE_URL"] ?? panic("PostgreSQL URL required");
    await withQueryPerfFixture({
      databaseUrl: url,
      profileId: "corpus",
      run: async (_db, _deadline, openClient) => {
        const measured = await measureHostedErasureHistory(openClient);
        process.stdout.write(
          `${JSON.stringify({ event: "hosted_erasure_read_measurement", measured })}\n`,
        );
        const small = measured.at(0) ?? panic("Missing small measurement");
        const large = measured.at(1) ?? panic("Missing large measurement");
        for (const run of measured) {
          expect(
            budgetProblem("scheduled.usage.eraseHostedCustomers", run.metrics),
          ).toBeUndefined();
        }
        expect(small.statements).toBeGreaterThan(1);
        expect(large.statements).toBe(small.statements);
        expect(
          scaleViolations({
            size: small.metrics.sharedBlocks,
            double: large.metrics.sharedBlocks,
          }),
        ).toEqual([]);
      },
    });
  });
});
