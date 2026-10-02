import { panic, Result } from "better-result";
import { describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";

import { member, organization, user } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import {
  rateEntries,
  rateTables,
  workspaceMembers,
  workspaces,
} from "@/api/db/schema";
import { createSafeDb, markRlsDatabase } from "@/api/db/scoped";
import { createBackgroundAuditRecorder } from "@/api/lib/audit-log";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { resolveRatesInTransaction } from "@/api/lib/billing/rates";
import { createSafeId } from "@/api/lib/branded-types";
import { cents } from "@/api/lib/money";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import type { GatedTestDb } from "@/api/tests/gated-test-database";
import {
  mintAuthProviderId,
  mintAuthProviderIdValue,
} from "@/api/tests/helpers/auth-provider-id";
import { createTestHandlerContext } from "@/api/tests/helpers/handler-context";

import deleteRateTable from "./delete";
import createRateEntry from "./entries/create";
import updateRateEntry from "./entries/update";
import updateRateTable from "./update";

/**
 * Rate tables, their currency and the rates under them are decided on as a
 * set. Each case here holds one session at a known point and lets a second
 * one run into it, so the order the two commit in is fixed, not left to
 * timing. Only separate PostgreSQL sessions show lock waits and per-statement
 * snapshots.
 */

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
  panic("The competing session did not wait for the session under test");
};

if (!databaseUrl || !runPostgres) {
  describe.skip("rate serialization (postgres)", () => {
    test("requires DATABASE_URL and STELLA_RUN_POSTGRES_TESTS=true", () =>
      expect(true).toBe(true));
  });
} else {
  const withRateFixture = async (
    currency: string,
    fn: (fixture: {
      firstDb: GatedTestDb;
      firstSafe: ReturnType<typeof createSafeDb>;
      secondSafe: ReturnType<typeof createSafeDb>;
      organizationId: ReturnType<typeof mintAuthProviderId<"organization">>;
      userId: ReturnType<typeof mintAuthProviderId<"user">>;
      workspaceId: ReturnType<typeof createSafeId<"workspace">>;
      tableId: (typeof rateTables.$inferSelect)["id"];
      entryId: (typeof rateEntries.$inferSelect)["id"];
      record: AuditRecorder;
      compete: (
        first: (gatedRecord: AuditRecorder) => Promise<unknown>,
        second: () => Promise<unknown>,
      ) => Promise<{ first: unknown; second: unknown }>;
      secondPid: number;
    }) => Promise<void>,
  ) => {
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
          trigger: { type: "system", source: "rate_serialization_test" },
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
        const [table] = await firstDb
          .insert(rateTables)
          .values({
            organizationId,
            workspaceId,
            name: "Standard",
            currency,
            isDefault: true,
          })
          .returning({ id: rateTables.id });
        const tableId = table?.id ?? panic("Rate table fixture missing");
        const [entry] = await firstDb
          .insert(rateEntries)
          .values({
            workspaceId,
            rateTableId: tableId,
            userId: null,
            hourlyRate: cents(10_000),
            effectiveFrom: "2024-01-01",
            effectiveTo: "2024-12-31",
          })
          .returning({ id: rateEntries.id });
        const entryId = entry?.id ?? panic("Rate line fixture missing");

        const pidRows = await secondDb
          .select({ pid: sql<number>`pg_backend_pid()` })
          .from(sql`(SELECT 1) AS backend_identity`);
        const secondPid =
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

        // `first` runs to its audit write, the last statement of its
        // transaction, and stays open there until `second` is seen waiting on
        // it. Only then does `first` commit.
        const compete = async (
          first: (gatedRecord: AuditRecorder) => Promise<unknown>,
          second: () => Promise<unknown>,
        ) => {
          const reached = Promise.withResolvers<undefined>();
          const started = Promise.withResolvers<undefined>();
          const tasks: Promise<unknown>[] = [];
          const gatedRecord: AuditRecorder = async (tx, events) => {
            await record(tx, events);
            reached.resolve(undefined);
            await started.promise;
            await observeBlocking(tx, secondPid);
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
            await Promise.allSettled(tasks);
          }
        };

        await fn({
          firstDb,
          firstSafe,
          secondSafe,
          organizationId,
          userId,
          workspaceId,
          tableId,
          entryId,
          record,
          compete,
          secondPid,
        });
      } finally {
        await firstDb
          .delete(organization)
          .where(eq(organization.id, organizationId));
        await firstDb.delete(user).where(eq(user.id, userId));
      }
    });
  };

  type UpdateTableContext = Parameters<typeof updateRateTable.handler>[0];
  type DeleteTableContext = Parameters<typeof deleteRateTable.handler>[0];
  type CreateEntryContext = Parameters<typeof createRateEntry.handler>[0];
  type UpdateEntryContext = Parameters<typeof updateRateEntry.handler>[0];

  test("a rate resolved while its table changes currency comes from one side of the change", async () => {
    await withRateFixture(
      "USD",
      async ({
        firstDb,
        secondSafe,
        userId,
        workspaceId,
        tableId,
        secondPid,
      }) => {
        const converted = Promise.withResolvers<undefined>();
        const resolving = Promise.withResolvers<undefined>();
        const tasks: Promise<unknown>[] = [];
        try {
          // The change holds the rate lines, so the resolver reads whatever it
          // reads before them from the old side and then waits. Its rates are
          // read once the change has committed.
          const conversion = firstDb.transaction(async (tx) => {
            await tx.execute(
              sql`LOCK TABLE ${rateEntries} IN ACCESS EXCLUSIVE MODE`,
            );
            await tx
              .update(rateTables)
              .set({ currency: "JPY" })
              .where(eq(rateTables.id, tableId));
            await tx
              .update(rateEntries)
              .set({ hourlyRate: cents(100) })
              .where(eq(rateEntries.rateTableId, tableId));
            converted.resolve(undefined);
            await resolving.promise;
            await observeBlocking(tx, secondPid);
          });
          tasks.push(conversion);
          await Promise.race([converted.promise, conversion]);
          const lookup = { userId, dateWorked: "2024-06-01" };
          const resolution = secondSafe(
            async (tx) =>
              await resolveRatesInTransaction({
                tx,
                workspaceId,
                lookups: [lookup],
              }),
          );
          tasks.push(resolution);
          resolving.resolve(undefined);
          await conversion;
          const rates = (await resolution).unwrap();

          // 100.00 USD became 100 JPY. Never 100 in USD, nor 10000 in JPY.
          expect([...rates.values()]).toEqual([
            { hourlyRate: cents(100), currency: "JPY" },
          ]);
        } finally {
          converted.resolve(undefined);
          resolving.resolve(undefined);
          await Promise.allSettled(tasks);
        }
      },
    );
  }, 30_000);

  test("a rate raised while its table changes currency is checked before it is restated", async () => {
    await withRateFixture(
      "JPY",
      async ({
        firstDb,
        firstSafe,
        secondSafe,
        organizationId,
        userId,
        workspaceId,
        tableId,
        entryId,
        record,
        compete,
      }) => {
        // Three decimals from none multiplies by a thousand: this rate is in
        // range as yen and out of range once restated in dinars.
        const beyondRange = Math.floor(Number.MAX_SAFE_INTEGER / 1000) + 1;
        const outcome = await compete(
          async (gatedRecord) =>
            await updateRateEntry.handler(
              createTestHandlerContext<UpdateEntryContext>({
                workspaceId,
                session: { activeOrganizationId: organizationId },
                user: { id: userId },
                safeDb: firstSafe,
                recordAuditEvent: gatedRecord,
                createAuditRecorder: () => gatedRecord,
                params: { rateTableId: tableId },
                body: { id: entryId, hourlyRate: beyondRange },
              }),
            ),
          async () =>
            await updateRateTable.handler(
              createTestHandlerContext<UpdateTableContext>({
                workspaceId,
                session: { activeOrganizationId: organizationId },
                user: { id: userId },
                safeDb: secondSafe,
                recordAuditEvent: record,
                createAuditRecorder: () => record,
                body: { id: tableId, currency: "KWD" },
              }),
            ),
        );
        expect(outcome.first).toEqual({ id: entryId });
        expect(outcome.second).toMatchObject({ code: 400 });

        const [table] = await firstDb
          .select({ currency: rateTables.currency })
          .from(rateTables)
          .where(eq(rateTables.id, tableId));
        expect(table?.currency).toBe("JPY");
        const [entry] = await firstDb
          .select({ hourlyRate: rateEntries.hourlyRate })
          .from(rateEntries)
          .where(eq(rateEntries.id, entryId));
        expect(entry?.hourlyRate).toBe(cents(beyondRange));
      },
    );
  }, 30_000);

  test("a rate line added while its table changes currency is restated with the others", async () => {
    await withRateFixture(
      "USD",
      async ({
        firstDb,
        firstSafe,
        secondSafe,
        organizationId,
        userId,
        workspaceId,
        tableId,
        record,
        compete,
      }) => {
        const outcome = await compete(
          async (gatedRecord) =>
            await createRateEntry.handler(
              createTestHandlerContext<CreateEntryContext>({
                workspaceId,
                session: { activeOrganizationId: organizationId },
                user: { id: userId },
                safeDb: firstSafe,
                recordAuditEvent: gatedRecord,
                createAuditRecorder: () => gatedRecord,
                params: { rateTableId: tableId },
                body: { hourlyRate: 25_050, effectiveFrom: "2025-01-01" },
              }),
            ),
          async () =>
            await updateRateTable.handler(
              createTestHandlerContext<UpdateTableContext>({
                workspaceId,
                session: { activeOrganizationId: organizationId },
                user: { id: userId },
                safeDb: secondSafe,
                recordAuditEvent: record,
                createAuditRecorder: () => record,
                body: { id: tableId, currency: "JPY" },
              }),
            ),
        );
        expect(outcome.first).toHaveProperty("id");
        expect(outcome.second).toEqual({ id: tableId });

        const [table] = await firstDb
          .select({ currency: rateTables.currency })
          .from(rateTables)
          .where(eq(rateTables.id, tableId));
        expect(table?.currency).toBe("JPY");
        const entries = await firstDb
          .select({
            effectiveFrom: rateEntries.effectiveFrom,
            hourlyRate: rateEntries.hourlyRate,
          })
          .from(rateEntries)
          .where(eq(rateEntries.rateTableId, tableId));
        // 100.00 USD is 100 JPY and 250.50 USD rounds to 251 JPY: the line
        // entered in dollars moved with the table, like the one already there.
        expect(
          new Map(entries.map((row) => [row.effectiveFrom, row.hourlyRate])),
        ).toEqual(
          new Map([
            ["2024-01-01", cents(100)],
            ["2025-01-01", cents(251)],
          ]),
        );
        expect(entries).toHaveLength(2);
      },
    );
  }, 30_000);

  test("a table made the default while it is being deleted is kept", async () => {
    await withRateFixture(
      "USD",
      async ({
        firstDb,
        firstSafe,
        secondSafe,
        organizationId,
        userId,
        workspaceId,
        tableId,
        record,
        compete,
      }) => {
        const [other] = await firstDb
          .insert(rateTables)
          .values({
            organizationId,
            workspaceId,
            name: "Other",
            currency: "USD",
            isDefault: false,
          })
          .returning({ id: rateTables.id });
        const otherId = other?.id ?? panic("Second rate table missing");
        const remove = async (
          safeDb: typeof firstSafe,
          id: typeof tableId,
          recordAuditEvent: AuditRecorder,
        ) =>
          await deleteRateTable.handler(
            createTestHandlerContext<DeleteTableContext>({
              workspaceId,
              session: { activeOrganizationId: organizationId },
              user: { id: userId },
              safeDb,
              recordAuditEvent,
              createAuditRecorder: () => recordAuditEvent,
              body: { id },
            }),
          );

        const outcome = await compete(
          async (gatedRecord) =>
            await updateRateTable.handler(
              createTestHandlerContext<UpdateTableContext>({
                workspaceId,
                session: { activeOrganizationId: organizationId },
                user: { id: userId },
                safeDb: firstSafe,
                recordAuditEvent: gatedRecord,
                createAuditRecorder: () => gatedRecord,
                body: { id: otherId, isDefault: true },
              }),
            ),
          async () => await remove(secondSafe, otherId, record),
        );
        expect(outcome.first).toEqual({ id: otherId });
        expect(outcome.second).toMatchObject({
          code: 400,
          response: {
            message:
              "Cannot delete the default rate table. " +
              "Set another table as default first.",
          },
        });
        const tables = await firstDb
          .select({ id: rateTables.id, isDefault: rateTables.isDefault })
          .from(rateTables)
          .where(eq(rateTables.workspaceId, workspaceId));
        expect(new Map(tables.map((row) => [row.id, row.isDefault]))).toEqual(
          new Map([
            [tableId, false],
            [otherId, true],
          ]),
        );

        // The table that is no longer the default can go; the default stays.
        expect(await remove(secondSafe, tableId, record)).toEqual({
          deleted: true,
        });
        expect(await remove(secondSafe, tableId, record)).toMatchObject({
          code: 404,
        });
        const remaining = await firstDb
          .select({ id: rateTables.id })
          .from(rateTables)
          .where(eq(rateTables.workspaceId, workspaceId));
        expect(remaining).toEqual([{ id: otherId }]);
      },
    );
  }, 30_000);
}
