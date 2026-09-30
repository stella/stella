import { panic, Result } from "better-result";
import { describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";

import { member, organization, user } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import {
  auditLogs,
  rateTables,
  workspaceMembers,
  workspaces,
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
import { createTestHandlerContext } from "@/api/tests/helpers/handler-context";

import createRateTable from "./create";
import updateRateTable from "./update";

const databaseUrl = process.env["DATABASE_URL"];
const runPostgres = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

const observeBlocking = async (tx: Transaction, pid: number) => {
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
  test("concurrent first creates and default promotions preserve one default and both audits", async () => {
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
            const results = await Promise.all([firstTask, secondTask]);
            for (const result of results) {
              expect(result.isOk()).toBe(true);
              if (result.isOk()) {
                expect(result.value).toHaveProperty("id");
              }
            }
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
              workspaceId,
              session: { activeOrganizationId: organizationId },
              user: { id: userId },
              safeDb,
              recordAuditEvent,
              createAuditRecorder: () => recordAuditEvent,
              body: { name, currency: "USD", isDefault: true },
            }),
          );
        await compete(
          async (gatedRecord) => await create(firstSafe, "First", gatedRecord),
          async () => await create(secondSafe, "Second", record),
        );
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
        const promote = async (
          safeDb: typeof firstSafe,
          id: typeof firstTable.id,
          recordAuditEvent: AuditRecorder,
        ) =>
          await updateRateTable.handler(
            createTestHandlerContext<UpdateContext>({
              workspaceId,
              session: { activeOrganizationId: organizationId },
              user: { id: userId },
              safeDb,
              recordAuditEvent,
              createAuditRecorder: () => recordAuditEvent,
              body: { id, isDefault: true },
            }),
          );
        await compete(
          async (gatedRecord) =>
            await promote(firstSafe, firstTable.id, gatedRecord),
          async () => await promote(secondSafe, secondTable.id, record),
        );
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
      } finally {
        await firstDb
          .delete(organization)
          .where(eq(organization.id, organizationId));
        await firstDb.delete(user).where(eq(user.id, userId));
      }
    });
  }, 30_000);
}
