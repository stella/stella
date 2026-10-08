import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { ElysiaCustomStatusResponse } from "elysia/error";

import { member, organization, user } from "@/api/db/auth-schema";
import {
  legalListColumns,
  legalLists,
  properties,
  workspaces,
} from "@/api/db/schema";
import { createSafeDb, markRlsDatabase } from "@/api/db/scoped";
import { createSafeId } from "@/api/lib/branded-types";
import { LIMITS } from "@/api/lib/limits";
import {
  LIST_COLUMN_LIMIT_ERROR_CODE,
  LIST_COLUMN_OVERFLOW_ERROR_CODE,
} from "@/api/lib/lists/column-error-codes";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import { auditRecorderDouble } from "@/api/tests/helpers/audit-recorder-double";
import {
  mintAuthProviderId,
  mintAuthProviderIdValue,
} from "@/api/tests/helpers/auth-provider-id";
import { createTestHandlerContext } from "@/api/tests/helpers/handler-context";

import readList from "../get";
import createColumn from "./create";

const databaseUrl = process.env["DATABASE_URL"];
const runPostgres = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

if (!databaseUrl || !runPostgres) {
  describe.skip("list column admission on PostgreSQL", () => {
    test("requires DATABASE_URL and STELLA_RUN_POSTGRES_TESTS=true", () => {});
  });
} else {
  test("parallel distinct columns admit one at the final slot and reads preserve the complete set", async () => {
    await withGatedTestClients(databaseUrl, async ({ openClient }) => {
      const { db: rootDb } = openClient();
      const db = markRlsDatabase(rootDb);
      const { db: controlDb } = openClient();
      const workerDbs = Array.from({ length: 4 }, () =>
        markRlsDatabase(openClient().db),
      );
      const organizationId = mintAuthProviderId<"organization">();
      const userId = mintAuthProviderId<"user">();
      const workspaceId = createSafeId<"workspace">();
      const listId = createSafeId<"legalList">();
      const propertyIds = Array.from(
        { length: LIMITS.legalListColumnsPerList + workerDbs.length },
        () => createSafeId<"property">(),
      );
      await db.insert(organization).values({
        id: organizationId,
        name: "List column fixture",
        slug: organizationId,
        createdAt: new Date(),
      });
      await db.insert(user).values({
        id: userId,
        name: "Fixture user",
        email: `${userId}@example.test`,
        emailVerified: true,
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
          name: "Fixture matter",
          reference: Bun.randomUUIDv7(),
        });
        await db.insert(legalLists).values({
          id: listId,
          workspaceId,
          name: "Fixture list",
          createdBy: userId,
        });
        await db.insert(properties).values(
          propertyIds.map((id) => ({
            id,
            workspaceId,
            name: id,
            status: "fresh" as const,
            content: { version: 1 as const, type: "text" as const },
            tool: { version: 1 as const, type: "manual-input" as const },
          })),
        );
        const initial = propertyIds.slice(
          0,
          LIMITS.legalListColumnsPerList - 1,
        );
        await db.insert(legalListColumns).values(
          initial.map((propertyId, position) => ({
            id: createSafeId<"legalListColumn">(),
            workspaceId,
            listId,
            propertyId,
            position,
          })),
        );
        const baseContext = {
          recordAuditEvent: auditRecorderDouble(),
          workspaceId,
          session: { activeOrganizationId: organizationId },
          user: { id: userId },
        };
        const read = async () =>
          await readList.handler(
            createTestHandlerContext<Parameters<typeof readList.handler>[0]>({
              ...baseContext,
              safeDb: createSafeDb(db, [workspaceId], organizationId, userId),
              params: { listId, workspaceId },
            }),
          );
        const before = await read();
        if (before instanceof ElysiaCustomStatusResponse) {
          panic("Fixture list must be readable");
        }
        expect(before.columns.map((column) => column.propertyId)).toEqual(
          initial,
        );

        const workers = await Promise.all(
          workerDbs.map(async (workerDb, index) => {
            const pidRows = await workerDb.execute<{ pid: number }>(
              sql`SELECT pg_backend_pid() AS pid`,
            );
            const pid =
              pidRows.at(0)?.pid ?? panic("Worker session must exist");
            const propertyId =
              propertyIds.at(initial.length + index) ??
              panic("Worker property must exist");
            return {
              pid,
              create: async () =>
                await createColumn.handler(
                  createTestHandlerContext<
                    Parameters<typeof createColumn.handler>[0]
                  >({
                    ...baseContext,
                    safeDb: createSafeDb(
                      workerDb,
                      [workspaceId],
                      organizationId,
                      userId,
                    ),
                    body: { listId, propertyId },
                  }),
                ),
            };
          }),
        );
        const pending: ReturnType<(typeof workers)[number]["create"]>[] = [];
        try {
          await controlDb.transaction(async (tx) => {
            await tx
              .select({ id: legalLists.id })
              .from(legalLists)
              .where(eq(legalLists.id, listId))
              .for("update");
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
              "All column workers must reach the locked admission boundary",
            );
          });
        } finally {
          // Drain writers after releasing the control lock, before deleting fixture rows.
          await Promise.all(pending);
        }
        const results = await Promise.all(pending);
        expect(
          results.filter(
            (result) => !(result instanceof ElysiaCustomStatusResponse),
          ),
        ).toHaveLength(1);
        const refused = results.filter(
          (result) => result instanceof ElysiaCustomStatusResponse,
        );
        expect(refused).toHaveLength(workers.length - 1);
        for (const refusal of refused) {
          expect(refusal.code).toBe(400);
          expect(refusal.response).toHaveProperty(
            "code",
            LIST_COLUMN_LIMIT_ERROR_CODE,
          );
        }
        expect(
          await db.$count(
            legalListColumns,
            eq(legalListColumns.listId, listId),
          ),
        ).toBe(LIMITS.legalListColumnsPerList);
        const after = await read();
        if (after instanceof ElysiaCustomStatusResponse) {
          panic("At-cap list must be readable");
        }
        expect(after.columns).toHaveLength(LIMITS.legalListColumnsPerList);
        expect(
          after.columns
            .slice(0, initial.length)
            .map((column) => column.propertyId),
        ).toEqual(initial);
        const admitted = results.find(
          (result) => !(result instanceof ElysiaCustomStatusResponse),
        );
        if (!admitted || admitted instanceof ElysiaCustomStatusResponse) {
          panic("One column must be admitted");
        }
        expect(after.columns.at(-1)?.id).toBe(admitted.id);

        const overflowProperty =
          propertyIds.at(-1) ?? panic("Overflow property must exist");
        await db.insert(legalListColumns).values({
          id: createSafeId<"legalListColumn">(),
          workspaceId,
          listId,
          propertyId: overflowProperty,
          position: LIMITS.legalListColumnsPerList,
        });
        const overflow = await read();
        expect(overflow).toBeInstanceOf(ElysiaCustomStatusResponse);
        if (overflow instanceof ElysiaCustomStatusResponse) {
          expect(overflow.code).toBe(409);
          expect(overflow.response).toHaveProperty(
            "code",
            LIST_COLUMN_OVERFLOW_ERROR_CODE,
          );
          expect(overflow.response).not.toHaveProperty("columns");
        }
        expect(
          await db.$count(
            legalListColumns,
            eq(legalListColumns.listId, listId),
          ),
        ).toBe(LIMITS.legalListColumnsPerList + 1);
      } finally {
        await db.delete(workspaces).where(eq(workspaces.id, workspaceId));
        await db
          .delete(organization)
          .where(eq(organization.id, organizationId));
        await db.delete(user).where(eq(user.id, userId));
      }
    });
  }, 20_000);
}
