import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";

import { entities } from "@/api/db/schema";
import readFilesystemTree from "@/api/handlers/entities/filesystem-tree/get";
import type { ApiRoutePath } from "@/api/http/api-route-types";
import { HttpStatusResponse } from "@/api/http/status";
import { createSafeId } from "@/api/lib/branded-types";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import { formatFieldContent } from "@/api/lib/views/export-format";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
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
    test("filesystem cursors retain filtered ancestors on every page", async () => {
      const databaseUrl =
        process.env["DATABASE_URL"] ?? panic("DATABASE_URL required");
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const { db } = openClient({ max: 1 });
        // Context-reference visibility reads public.entities, so this journey
        // uses the migrated tables rather than temporary shadow tables.
        const fixture = await seedEntityReadScaling(db, 3);
        try {
          const documents = await db
            .select({ id: entities.id })
            .from(entities)
            .where(eq(entities.workspaceId, fixture.workspaceId));
          const root = createSafeId<"entity">();
          const folder = createSafeId<"entity">();
          await db.insert(entities).values([
            {
              id: root,
              workspaceId: fixture.workspaceId,
              kind: "folder",
              name: "Root folder",
            },
            {
              id: folder,
              workspaceId: fixture.workspaceId,
              kind: "folder",
              name: "Nested folder",
              parentId: root,
            },
          ]);
          await db
            .update(entities)
            .set({ parentId: folder })
            .where(
              inArray(
                entities.id,
                documents.map(({ id }) => id),
              ),
            );
          const propertyId =
            fixture.propertyIds.at(0) ?? panic("Fixture property required");
          const seen = new Set<string>();
          let cursor: string | undefined;
          let pages = 0;
          do {
            const response = await readFilesystemTree.handler(
              asTestRaw<Parameters<typeof readFilesystemTree.handler>[0]>({
                workspaceId: fixture.workspaceId,
                user: { id: fixture.userId },
                session: { activeOrganizationId: fixture.organizationId },
                memberRole: sessionMemberRole("owner"),
                body: {
                  limit: 1,
                  cursor,
                  filters: [
                    {
                      type: "predicate",
                      operand: { type: "property", propertyId },
                      op: "contains",
                      value: "x",
                    },
                  ],
                },
                safeDb: fixture.safeDb,
                request: new Request(
                  "https://example.test/v1/entities/filesystem-tree",
                ),
                route:
                  "/v1/entities/:workspaceId/filesystem-tree" satisfies ApiRoutePath,
              }),
            );
            if (response instanceof HttpStatusResponse) {
              panic("Filesystem cursor fixture requires a successful page");
            }
            expect(response.items).toHaveLength(1);
            for (const item of response.items) {
              expect(seen.has(item.entityId)).toBe(false);
              seen.add(item.entityId);
              expect(item.parentId).toBe(folder);
            }
            expect(
              new Map(
                response.ancestorLinks.map(({ entityId, parentId }) => [
                  entityId,
                  parentId,
                ]),
              ),
            ).toEqual(
              new Map([
                [root, null],
                [folder, root],
              ]),
            );
            cursor = response.nextCursor ?? undefined;
            pages += 1;
            expect(pages).toBeLessThanOrEqual(documents.length);
          } while (cursor !== undefined);
          expect(pages).toBe(documents.length);
          expect(seen).toEqual(new Set(documents.map(({ id }) => id)));
        } finally {
          await fixture.cleanup();
        }
      });
    });

    test("keeps selected text payloads bounded as rows, properties and values grow", async () => {
      const databaseUrl =
        process.env["DATABASE_URL"] ?? panic("DATABASE_URL required");
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const { db } = openClient({ max: 1 });
        await prepareEntityReadScalingTables(db);
        const small = await seedEntityReadScaling(db, 10);
        const large = await seedEntityReadScaling(db, 200);
        try {
          const at10 = await small.measure({
            fieldMode: "visible",
            textMode: "preview",
          });
          const at200 = await large.measure({
            fieldMode: "visible",
            textMode: "preview",
          });
          const allFields = await large.measure({
            fieldMode: "full",
            textMode: "preview",
          });
          const exportFields = await large.measure({
            fieldMode: "visible",
            textMode: "full",
          });
          for (const row of exportFields.entities) {
            const field =
              row.fields.at(0) ??
              panic("Full export fixture requires a selected text field");
            expect(field.content).toEqual({
              version: 1,
              type: "text",
              value: large.textValue,
            });
            expect(formatFieldContent(field.content, "en")).toBe(
              large.textValue,
            );
          }

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
