import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { ElysiaCustomStatusResponse } from "elysia/error";

import { LIST_ITEM_TYPE } from "@stll/api-contract/entity-options";

import { member, organization, user } from "@/api/db/auth-schema";
import {
  entities,
  entityVersions,
  fields,
  legalListFactDetails,
  legalListItems,
  legalLists,
  properties,
  workspaces,
} from "@/api/db/schema";
import { createSafeDb, markRlsDatabase } from "@/api/db/scoped";
import { env } from "@/api/env";
import { createSafeId } from "@/api/lib/branded-types";
import {
  LEGAL_LISTS_FEATURE_ID,
  LIST_VERIFICATION_FEATURE_ID,
} from "@/api/lib/feature-access/registry";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import { auditRecorderDouble } from "@/api/tests/helpers/audit-recorder-double";
import {
  mintAuthProviderId,
  mintAuthProviderIdValue,
} from "@/api/tests/helpers/auth-provider-id";
import { organizationFeatureGrants } from "@/api/tests/helpers/feature-grants";
import {
  NO_DB,
  createTestHandlerContext,
} from "@/api/tests/helpers/handler-context";
import { createTestState } from "@/api/tests/helpers/test-state";

import updateFactDetails from "../lists/items/fact-details/update";
import upsertField from "./upsert";

const databaseUrl = process.env["DATABASE_URL"];
const runPostgres = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";
const testState = createTestState({ file: import.meta.path, config: env });

if (!databaseUrl || !runPostgres) {
  describe.skip("absent replacement races on PostgreSQL", () => {
    test("requires DATABASE_URL and STELLA_RUN_POSTGRES_TESTS=true", () => {});
  });
} else {
  for (const resource of ["field", "fact-details"] as const) {
    test(`concurrent null-token ${resource} creates admit one writer and conflict the other`, async () => {
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const db = openClient().db;
        const controlDb = openClient().db;
        const workerDbs = [openClient().db, openClient().db];
        const organizationId = mintAuthProviderId<"organization">();
        const userId = mintAuthProviderId<"user">();
        const workspaceId = createSafeId<"workspace">();
        const entityId = createSafeId<"entity">();
        const entityVersionId = createSafeId<"entityVersion">();
        const propertyId = createSafeId<"property">();
        const listId = createSafeId<"legalList">();
        const audits: unknown[] = [];
        testState.setConfig(
          "API_FEATURE_ACCESS_GRANTS",
          organizationFeatureGrants(organizationId, [
            LEGAL_LISTS_FEATURE_ID,
            LIST_VERIFICATION_FEATURE_ID,
          ]),
        );
        await db.insert(organization).values({
          id: organizationId,
          name: "Replacement race fixture",
          slug: organizationId,
          createdAt: new Date(),
        });
        await db.insert(user).values({
          id: userId,
          name: "Fixture user",
          email: `${userId}@example.test`,
        });
        try {
          await db.insert(member).values({
            id: mintAuthProviderIdValue(),
            organizationId,
            userId,
            role: "owner",
            createdAt: new Date(),
          });
          await db.insert(workspaces).values({
            id: workspaceId,
            organizationId,
            name: "Replacement race fixture",
            reference: workspaceId,
          });
          await db.insert(entities).values({
            id: entityId,
            workspaceId,
            name: "Replacement race fixture",
            kind: resource === "field" ? "document" : "task",
            listItemType: resource === "field" ? null : LIST_ITEM_TYPE.FACT,
          });
          await db.insert(entityVersions).values({
            id: entityVersionId,
            workspaceId,
            entityId,
          });
          await db
            .update(entities)
            .set({ currentVersionId: entityVersionId })
            .where(eq(entities.id, entityId));
          await db.insert(properties).values({
            id: propertyId,
            workspaceId,
            name: "Fixture property",
            status: "fresh",
            content: { version: 1, type: "text" },
            tool: { version: 1, type: "manual-input" },
          });
          await db.insert(legalLists).values({
            id: listId,
            workspaceId,
            name: "Fixture list",
            createdBy: userId,
          });
          if (resource === "fact-details") {
            await db.insert(legalListItems).values({
              entityId,
              workspaceId,
              listId,
              position: "a0",
            });
          }

          const workers = await Promise.all(
            workerDbs.map(async (workerDb, index) => {
              const pid =
                (
                  await workerDb.execute<{ pid: number }>(
                    sql`SELECT pg_backend_pid() AS pid`,
                  )
                ).at(0)?.pid ?? panic("Worker session must exist");
              const value = `writer-${index}`;
              const baseContext = {
                scopedDb: NO_DB,
                audit: auditRecorderDouble((events) => {
                  audits.push(...events);
                }),
                safeDb: createSafeDb(
                  markRlsDatabase(workerDb),
                  [workspaceId],
                  organizationId,
                  userId,
                ),
                workspaceId,
                session: { activeOrganizationId: organizationId },
                user: { id: userId },
              };
              return {
                pid,
                value,
                create: async () =>
                  resource === "field"
                    ? await upsertField.handler(
                        createTestHandlerContext<
                          Parameters<typeof upsertField.handler>[0]
                        >({
                          ...baseContext,
                          body: {
                            entityId,
                            propertyId,
                            content: { version: 1, type: "text", value },
                            expectedUpdatedAt: null,
                          },
                        }),
                      )
                    : await updateFactDetails.handler(
                        createTestHandlerContext<
                          Parameters<typeof updateFactDetails.handler>[0]
                        >({
                          ...baseContext,
                          body: {
                            listId,
                            itemEntityId: entityId,
                            occurredOn: null,
                            evidenceKind: value,
                            medium: null,
                            confidence: "high",
                            interpretationNote: null,
                            scoring: "included",
                            expectedUpdatedAt: null,
                          },
                        }),
                      ),
              };
            }),
          );
          const pending: ReturnType<(typeof workers)[number]["create"]>[] = [];
          try {
            await controlDb.transaction(async (tx) => {
              if (resource === "fact-details") {
                // SHARE permits both missing-row reads, then holds both inserts
                // until their null preconditions have passed.
                await tx.execute(
                  sql`LOCK TABLE legal_list_fact_details IN SHARE MODE`,
                );
              } else {
                await tx
                  .select({ id: entities.id })
                  .from(entities)
                  .where(eq(entities.id, entityId))
                  .for("update");
              }
              pending.push(
                ...workers.map(async (worker) => await worker.create()),
              );
              const deadline = performance.now() + 5000;
              while (performance.now() < deadline) {
                const snapshot = await db.execute<{ waiting: number }>(sql`
                  SELECT count(*)::integer AS waiting FROM pg_stat_activity
                  WHERE pid IN (${sql.join(
                    workers.map(({ pid }) => sql`${pid}`),
                    sql`, `,
                  )})
                    AND wait_event_type = 'Lock'`);
                if (snapshot.at(0)?.waiting === workers.length) {
                  return;
                }
                await Bun.sleep(10);
              }
              panic(
                "Both replacement workers must reach the database lock boundary",
              );
            });
          } finally {
            // Release control locks and drain both sessions before fixture cleanup.
            await Promise.all(pending);
          }
          const results = await Promise.all(pending);
          expect(
            results
              .map((result) =>
                result instanceof ElysiaCustomStatusResponse
                  ? result.code
                  : 200,
              )
              .toSorted(),
          ).toEqual([200, 409]);
          const refusal = results.find(
            (result) => result instanceof ElysiaCustomStatusResponse,
          );
          expect(refusal?.response).toHaveProperty("code", "version_conflict");
          expect(audits).toHaveLength(1);
          const winnerIndex = results.findIndex(
            (result) => !(result instanceof ElysiaCustomStatusResponse),
          );
          const winner =
            workers.at(winnerIndex) ??
            panic("Exactly one replacement must win");
          if (resource === "field") {
            const stored = await db
              .select({ content: fields.content })
              .from(fields)
              .where(eq(fields.entityVersionId, entityVersionId));
            expect(stored).toEqual([
              { content: { version: 1, type: "text", value: winner.value } },
            ]);
          } else {
            const stored = await db
              .select({ evidenceKind: legalListFactDetails.evidenceKind })
              .from(legalListFactDetails)
              .where(eq(legalListFactDetails.itemEntityId, entityId));
            expect(stored).toEqual([{ evidenceKind: winner.value }]);
          }
        } finally {
          await db
            .delete(organization)
            .where(eq(organization.id, organizationId));
          await db.delete(user).where(eq(user.id, userId));
        }
      });
    }, 15_000);
  }
}
