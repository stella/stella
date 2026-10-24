import { panic } from "better-result";
import { describe, expect, test } from "bun:test";

import { createWebHandoffToolSet } from "@/api/mcp/web-handoff-links";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import {
  prepareEntityReadScalingTables,
  seedEntityReadScaling,
} from "@/api/tests/read-scaling/entity-fixture";
import { mcpScalingScenarios } from "@/api/tests/read-scaling/mcp-scenarios";
import { readScalingViolations } from "@/api/tests/read-scaling/measurement";

describe.skipIf(process.env["STELLA_RUN_POSTGRES_TESTS"] !== "true")(
  "registered MCP tool scaling",
  () => {
    test("every registered case measures production tool handlers at both cardinalities", async () => {
      const databaseUrl =
        process.env["DATABASE_URL"] ?? panic("DATABASE_URL required");
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const { db } = openClient({ max: 1 });
        await prepareEntityReadScalingTables(db);
        const small = await seedEntityReadScaling(db, 10);
        const large = await seedEntityReadScaling(db, 200);
        try {
          for (const scenario of mcpScalingScenarios) {
            const at10 =
              scenario.kind === "credential-mint"
                ? await scenario.measure(small, createWebHandoffToolSet)
                : await scenario.measure(small);
            const at200 =
              scenario.kind === "credential-mint"
                ? await scenario.measure(large, createWebHandoffToolSet)
                : await scenario.measure(large);
            console.info(
              "mcp-scaling",
              JSON.stringify({ name: scenario.name, at10, at200 }),
            );
            if (scenario.kind === "credential-mint") {
              const plain10 = await scenario.measurePlain(
                small,
                createWebHandoffToolSet,
              );
              const plain200 = await scenario.measurePlain(
                large,
                createWebHandoffToolSet,
              );
              for (const plain of [plain10, plain200]) {
                expect(plain.statements).toBe(0);
                expect(plain.transactionRoundTrips).toBe(0);
                expect(plain.rows).toBe(1);
              }
              expect(
                readScalingViolations({ small: plain10, large: plain200 }),
              ).toEqual([]);
            }
            const expectedRows = scenario.kind === "credential-mint" ? 1 : 10;
            expect(at10.rows).toBe(expectedRows);
            expect(at200.rows).toBe(expectedRows);
            expect(at10.statements).toBeGreaterThan(0);
            expect(at10.transactionRoundTrips).toBeGreaterThan(0);
            expect(
              readScalingViolations({ small: at10, large: at200 }),
            ).toEqual([]);
          }
        } finally {
          await small.cleanup();
          await large.cleanup();
        }
      });
    }, 120_000);
  },
);
