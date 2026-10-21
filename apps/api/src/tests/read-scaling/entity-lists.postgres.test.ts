import { panic } from "better-result";
import { describe, expect, test } from "bun:test";

import { withGatedTestClients } from "@/api/tests/gated-test-database";
import {
  prepareEntityReadScalingTables,
  seedEntityReadScaling,
} from "@/api/tests/read-scaling/entity-fixture";
import {
  measureCompleteFilesystemTree,
  measureReadFilesystemTree,
} from "@/api/tests/read-scaling/filesystem-tree";
import { readScalingViolations } from "@/api/tests/read-scaling/measurement";

describe.skipIf(process.env["STELLA_RUN_POSTGRES_TESTS"] !== "true")(
  "entity list payload scaling",
  () => {
    test("keeps selected text payloads bounded as rows, properties and values grow", async () => {
      const databaseUrl =
        process.env["DATABASE_URL"] ?? panic("DATABASE_URL required");
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const { db } = openClient({ max: 1 });
        await prepareEntityReadScalingTables(db);
        const small = await seedEntityReadScaling(db, 10);
        const large = await seedEntityReadScaling(db, 200);
        try {
          const at10 = await small.measure("visible");
          const at200 = await large.measure("visible");
          const allFields = await large.measure("full");
          console.info(
            JSON.stringify({
              entityList: {
                at10: {
                  bytes: at10.responseBytes,
                  statements: at10.statements,
                  transactions: at10.transactionRoundTrips,
                },
                at200: {
                  bytes: at200.responseBytes,
                  statements: at200.statements,
                  transactions: at200.transactionRoundTrips,
                },
                allFields: {
                  bytes: allFields.responseBytes,
                  statements: allFields.statements,
                  transactions: allFields.transactionRoundTrips,
                },
              },
            }),
          );
          expect(at10.rows).toBe(10);
          expect(at200.rows).toBe(10);
          expect(
            readScalingViolations({
              small: {
                statements: at10.statements,
                transactionRoundTrips: at10.transactionRoundTrips,
                responseBytes: at10.responseBytes,
                rows: at10.rows,
              },
              large: {
                statements: at200.statements,
                transactionRoundTrips: at200.transactionRoundTrips,
                responseBytes: at200.responseBytes,
                rows: at200.rows,
              },
            }),
          ).toEqual([]);
          expect(at200.statements).toBe(at10.statements);
          expect(at200.transactionRoundTrips).toBe(at10.transactionRoundTrips);
          expect(at200.responseBytes / at10.responseBytes).toBeLessThanOrEqual(
            1.2,
          );
          expect(allFields.responseBytes).toBeGreaterThan(
            at200.responseBytes * 50,
          );
          for (const row of at200.entities) {
            expect(row.fields.at(0)?.content).toMatchObject({
              type: "text",
              truncated: true,
              value: "x".repeat(512),
            });
          }

          const treeAt10 = await measureReadFilesystemTree(small);
          const treeAt200 = await measureReadFilesystemTree(large);
          const completeTree = await measureCompleteFilesystemTree(large);
          expect(treeAt10.rows).toBe(10);
          expect(treeAt200.rows).toBe(10);
          expect(completeTree.rows).toBe(200);
          expect(treeAt10.statements).toBeGreaterThan(0);
          expect(treeAt10.transactionRoundTrips).toBeGreaterThan(0);
          expect(
            readScalingViolations({ small: treeAt10, large: treeAt200 }),
          ).toEqual([]);
          expect(completeTree.responseBytes).toBeGreaterThan(
            treeAt200.responseBytes * 50,
          );
          console.info(
            "filesystem-tree-scaling",
            JSON.stringify({
              at10: treeAt10,
              at200: treeAt200,
              complete: completeTree,
            }),
          );
        } finally {
          await small.cleanup();
          await large.cleanup();
        }
      });
    }, 120_000);
  },
);
