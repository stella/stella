import { panic } from "better-result";
import { describe, expect, test } from "bun:test";

import { createReadDecisionAnchorRedirectsHandler } from "@/api/handlers/case-law/decisions/anchor-redirects";
import { withGatedTestClients } from "@/api/tests/gated-test-database";

import { decisionAnchorRedirectsScalingScenario } from "./decision-anchor-redirects";
import { readScalingViolations } from "./measurement";

describe.skipIf(process.env["STELLA_RUN_POSTGRES_TESTS"] !== "true")(
  "public decision anchor redirects scaling",
  () => {
    test("answers one anchor in bounded work as a decision's redirects grow", async () => {
      const databaseUrl =
        process.env["DATABASE_URL"] ?? panic("DATABASE_URL required");
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const small = await decisionAnchorRedirectsScalingScenario.measure({
          size: 10,
          db: openClient().db,
          createHandler: createReadDecisionAnchorRedirectsHandler,
        });
        const large = await decisionAnchorRedirectsScalingScenario.measure({
          size: 2000,
          db: openClient().db,
          createHandler: createReadDecisionAnchorRedirectsHandler,
        });
        expect(small.rows).toBe(1);
        expect(large.rows).toBe(1);
        expect(small.statements).toBeGreaterThan(0);
        expect(readScalingViolations({ small, large })).toEqual([]);
      });
    });
  },
);
