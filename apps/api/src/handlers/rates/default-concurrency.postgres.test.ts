import { panic, Result } from "better-result";
import { describe, expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import type { PgAsyncDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

import { member, organization, user } from "@/api/db/auth-schema";
import {
  auditLogs,
  rateTables,
  workspaceMembers,
  workspaces,
  featureEnrolments,
} from "@/api/db/schema";
import { createSafeDb, markRlsDatabase } from "@/api/db/scoped";
import {
  AUDIT_ACTION,
  createBackgroundAuditRecorder,
} from "@/api/lib/audit-log";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import {
  mintAuthProviderId,
  mintAuthProviderIdValue,
} from "@/api/tests/helpers/auth-provider-id";
import {
  NO_DB,
  createTestHandlerContext,
} from "@/api/tests/helpers/handler-context";

import createRateTable from "./create";
import updateRateTable from "./update";

const databaseUrl = process.env["DATABASE_URL"];
const runPostgres = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

const observeBlocking = async (
  tx: Pick<PgAsyncDatabase<PgQueryResultHKT>, "select">,
  pid: number,
) => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const rows = await tx
      .select({
        blocked: sql<boolean>`pg_backend_pid() = ANY(pg_blocking_pids(${pid}))`,
      })
      .from(sql`(SELECT 1) AS lock_observation`);
    if (rows.at(0)?.blocked) {
      return;
    }
    await Bun.sleep(10);
  }
  panic("Concurrent rate default mutation did not reach the workspace lock");
};

if (!databaseUrl || !runPostgres) {
  describe.skip("rate default serialization (postgres)", () => {
    test("requires DATABASE_URL and STELLA_RUN_POSTGRES_TESTS=true", () =>
      expect(true).toBe(true));
  });
} else {
  test("concurrent first creates, default promotions and default removals preserve one default and their audits", async () => {
    await withGatedTestClients(databaseUrl, async ({ openClient }) => {
      const { db: firstDb } = openClient({ max: 1 });
      const { db: secondDb } = openClient({ max: 1 });
      const organizationId = mintAuthProviderId<"organization">();
      const userId = mintAuthProviderId<"user">();
      const workspaceId = createSafeId<"workspace">();
      const record = createBackgroundAuditRecorder({
        organizationId,
        workspaceId,
        userId,
        execution: {
          performer: { type: "user", id: userId },
          trigger: { type: "system", source: "rate_default_test" },
        },
      });
      try {
        await firstDb.insert(user).values({
          id: userId,
          name: "Rate test member",
          email: `${userId}@example.test`,
          emailVerified: true,
        });
        await firstDb.insert(organization).values({
          id: organizationId,
          name: "Rate test organization",
          slug: organizationId,
          createdAt: new Date(),
        });
        await firstDb.insert(member).values({
          id: mintAuthProviderIdValue(),
          organizationId,
          userId,
          role: "owner",
          createdAt: new Date(),
        });
        await firstDb.insert(featureEnrolments).values({
          organizationId,
          userId,
          featureId: "time-billing",
        });
        await firstDb.insert(workspaces).values({
          id: workspaceId,
          organizationId,
          name: "Rate test matter",
          reference: workspaceId,
        });
        await firstDb.insert(workspaceMembers).values({ workspaceId, userId });
        const pidRows = await secondDb
          .select({ pid: sql<number>`pg_backend_pid()` })
          .from(sql`(SELECT 1) AS backend_identity`);
        const pid =
          pidRows.at(0)?.pid ?? panic("Second backend identity missing");
        const firstSafe = createSafeDb(
          markRlsDatabase(firstDb),
          [workspaceId],
          organizationId,
          userId,
        );
        const secondSafe = createSafeDb(
          markRlsDatabase(secondDb),
          [workspaceId],
          organizationId,
          userId,
        );

        const compete = async (
          first: (gatedRecord: AuditRecorder) => Promise<unknown>,
          second: () => Promise<unknown>,
        ) => {
          const reached = Promise.withResolvers<undefined>();
          const started = Promise.withResolvers<undefined>();
          const release = Promise.withResolvers<undefined>();
          const blocked = Promise.withResolvers<undefined>();
          const tasks: Promise<unknown>[] = [];
          const gatedRecord: AuditRecorder = async (tx, events) => {
            await record(tx, events);
            reached.resolve(undefined);
            await started.promise;
            await observeBlocking(tx, pid);
            blocked.resolve(undefined);
            await release.promise;
          };
          try {
            const firstTask = Result.tryPromise(
              async () => await first(gatedRecord),
            );
            tasks.push(firstTask);
            await Promise.race([
              reached.promise,
              firstTask.then(() =>
                panic("First mutation finished before its audit gate"),
              ),
            ]);
            const secondTask = Result.tryPromise(second);
            tasks.push(secondTask);
            started.resolve(undefined);
            await Promise.race([
              blocked.promise,
              firstTask.then(() =>
                panic("First mutation failed before observing its competitor"),
              ),
            ]);
            release.resolve(undefined);
            const [firstResult, secondResult] = await Promise.all([
              firstTask,
              secondTask,
            ]);
            return {
              first: firstResult.unwrap(),
              second: secondResult.unwrap(),
            };
          } finally {
            reached.resolve(undefined);
            started.resolve(undefined);
            release.resolve(undefined);
            blocked.resolve(undefined);
            await Promise.allSettled(tasks);
          }
        };
        type CreateContext = Parameters<typeof createRateTable.handler>[0];
        const create = async (
          safeDb: typeof firstSafe,
          name: string,
          recordAuditEvent: AuditRecorder,
        ) =>
          await createRateTable.handler(
            createTestHandlerContext<CreateContext>({
              scopedDb: NO_DB,
              workspaceId,
              session: { activeOrganizationId: organizationId },
              user: { id: userId },
              safeDb,
              audit: recordAuditEvent,
              body: { name, currency: "USD", isDefault: true },
            }),
          );
        const creations = await compete(
          async (gatedRecord) => await create(firstSafe, "First", gatedRecord),
          async () => await create(secondSafe, "Second", record),
        );
        expect(creations.first).toHaveProperty("id");
        expect(creations.second).toHaveProperty("id");
        const created = await firstDb
          .select()
          .from(rateTables)
          .where(eq(rateTables.workspaceId, workspaceId));
        expect(created).toHaveLength(2);
        expect(created.filter((row) => row.isDefault)).toHaveLength(1);
        const firstTable =
          created.find((row) => row.name === "First") ??
          panic("First table missing");
        const secondTable =
          created.find((row) => row.name === "Second") ??
          panic("Second table missing");
        expect(secondTable.isDefault).toBe(true);
        const creationAudits = await firstDb
          .select()
          .from(auditLogs)
          .where(eq(auditLogs.workspaceId, workspaceId));
        expect(
          creationAudits
            .filter((event) => event.action === AUDIT_ACTION.CREATE)
            .map((event) => event.resourceId)
            .toSorted(),
        ).toEqual([firstTable.id, secondTable.id].toSorted());
        expect(
          creationAudits.filter(
            (event) => event.action === AUDIT_ACTION.UPDATE,
          ),
        ).toHaveLength(1);

        type UpdateContext = Parameters<typeof updateRateTable.handler>[0];
        const setDefault = async (
          safeDb: typeof firstSafe,
          id: typeof firstTable.id,
          isDefault: boolean,
          recordAuditEvent: AuditRecorder,
        ) =>
          await updateRateTable.handler(
            createTestHandlerContext<UpdateContext>({
              scopedDb: NO_DB,
              workspaceId,
              session: { activeOrganizationId: organizationId },
              user: { id: userId },
              safeDb,
              audit: recordAuditEvent,
              body: { id, isDefault },
            }),
          );
        const promotions = await compete(
          async (gatedRecord) =>
            await setDefault(firstSafe, firstTable.id, true, gatedRecord),
          async () =>
            await setDefault(secondSafe, secondTable.id, true, record),
        );
        expect(promotions.first).toHaveProperty("id");
        expect(promotions.second).toHaveProperty("id");
        const promoted = await firstDb
          .select()
          .from(rateTables)
          .where(eq(rateTables.workspaceId, workspaceId));
        expect(
          promoted.filter((row) => row.isDefault).map((row) => row.id),
        ).toEqual([secondTable.id]);
        const allAudits = await firstDb
          .select()
          .from(auditLogs)
          .where(eq(auditLogs.workspaceId, workspaceId));
        const creationIds = new Set(creationAudits.map((event) => event.id));
        const promotionAudits = allAudits.filter(
          (event) => !creationIds.has(event.id),
        );
        expect(promotionAudits).toHaveLength(4);
        for (const id of [firstTable.id, secondTable.id]) {
          const tableAudits = promotionAudits.filter(
            (event) => event.resourceId === id,
          );
          expect(tableAudits).toHaveLength(2);
          expect(tableAudits.map((event) => event.changes)).toEqual(
            expect.arrayContaining([
              { isDefault: { old: false, new: true } },
              { isDefault: { old: true, new: false } },
            ]),
          );
        }

        const defaultIds = async () => {
          const rows = await firstDb
            .select({ id: rateTables.id })
            .from(rateTables)
            .where(
              and(
                eq(rateTables.workspaceId, workspaceId),
                eq(rateTables.isDefault, true),
              ),
            );
          return rows.map((row) => row.id);
        };
        const auditCount = async () =>
          await firstDb.$count(
            auditLogs,
            eq(auditLogs.workspaceId, workspaceId),
          );
        const refusal = {
          code: 400,
          response: {
            message: "Cannot unset default: no other default rate table exists",
          },
        };

        // The second table is the only default. Clearing the flag on the first
        // one looks safe until the competing promotion of that same table
        // commits and clears the second; the removal must see that outcome.
        const beforePromotedRemoval = await auditCount();
        const promotedRemoval = await compete(
          async (gatedRecord) =>
            await setDefault(firstSafe, firstTable.id, true, gatedRecord),
          async () =>
            await setDefault(secondSafe, firstTable.id, false, record),
        );
        expect(promotedRemoval.first).toEqual({ id: firstTable.id });
        expect(promotedRemoval.second).toMatchObject(refusal);
        expect(await defaultIds()).toEqual([firstTable.id]);
        // Promotion writes one audit per table; the refused removal writes none.
        expect(await auditCount()).toBe(beforePromotedRemoval + 2);

        // Two defaults, as rows written before defaults were serialized can
        // be. Each removal alone leaves the other table as the default; both
        // together must not leave the matter without one.
        await firstDb
          .update(rateTables)
          .set({ isDefault: true })
          .where(eq(rateTables.workspaceId, workspaceId));
        expect(await defaultIds()).toHaveLength(2);
        const beforePairedRemoval = await auditCount();
        const pairedRemoval = await compete(
          async (gatedRecord) =>
            await setDefault(firstSafe, firstTable.id, false, gatedRecord),
          async () =>
            await setDefault(secondSafe, secondTable.id, false, record),
        );
        expect(pairedRemoval.first).toEqual({ id: firstTable.id });
        expect(pairedRemoval.second).toMatchObject(refusal);
        expect(await defaultIds()).toEqual([secondTable.id]);
        expect(await auditCount()).toBe(beforePairedRemoval + 1);
      } finally {
        await firstDb
          .delete(organization)
          .where(eq(organization.id, organizationId));
        await firstDb.delete(user).where(eq(user.id, userId));
      }
    });
  }, 30_000);
}
