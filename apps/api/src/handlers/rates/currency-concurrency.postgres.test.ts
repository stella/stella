import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";

import { member, organization, user } from "@/api/db/auth-schema";
import {
  featureEnrolments,
  rateEntries,
  rateTables,
  workspaceMembers,
  workspaces,
} from "@/api/db/schema";
import { createSafeDb, markRlsDatabase } from "@/api/db/scoped";
import type { AuditRecorder } from "@/api/lib/audit-log";
import {
  rateLookupKey,
  resolveRatesInTransaction,
} from "@/api/lib/billing/rates";
import { createSafeId } from "@/api/lib/branded-types";
import { cents } from "@/api/lib/money";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import {
  mintAuthProviderId,
  mintAuthProviderIdValue,
} from "@/api/tests/helpers/auth-provider-id";
import {
  createTestHandlerContext,
  NO_DB,
} from "@/api/tests/helpers/handler-context";
import { withTimeBillingEnrolment } from "@/api/tests/helpers/time-billing-enrolment";
import { waitForBlockedPid } from "@/api/tests/helpers/wait-for-blocked-pid";

import updateRateEntry from "./entries/update";
import updateRateTable from "./update";

const databaseUrl = process.env["DATABASE_URL"];
const runPostgres = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

if (!databaseUrl || !runPostgres) {
  describe.skip("rate-entry currency serialization (postgres)", () => {
    test("requires DATABASE_URL and STELLA_RUN_POSTGRES_TESTS=true", () =>
      expect(true).toBe(true));
  });
} else {
  // timeout: Three real PostgreSQL sessions race a currency change through a lock barrier.
  test("rate-line writes reject stale units or commit before conversion", async () => {
    await withGatedTestClients(databaseUrl, async ({ openClient }) => {
      const setup = openClient({ max: 1 });
      const entryClient = openClient({ max: 1 });
      const tableClient = openClient({ max: 1 });
      const organizationId = mintAuthProviderId<"organization">();
      const userId = mintAuthProviderId<"user">();
      const workspaceId = createSafeId<"workspace">();
      const rateTableId = createSafeId<"rateTable">();
      const rateEntryId = createSafeId<"rateEntry">();
      const dateWorked = "2026-01-15";
      const record: AuditRecorder = async () => {};
      try {
        await setup.db.insert(user).values({
          id: userId,
          name: "Rate currency serialization",
          email: `${userId}@rate-currency.test`,
          emailVerified: true,
        });
        await setup.db.insert(organization).values({
          id: organizationId,
          name: "Rate currency serialization",
          slug: organizationId,
          createdAt: new Date(),
        });
        await setup.db.insert(member).values({
          id: mintAuthProviderIdValue(),
          organizationId,
          userId,
          role: "owner",
          createdAt: new Date(),
        });
        await setup.db.insert(featureEnrolments).values({
          organizationId,
          userId,
          featureId: "time-billing",
        });
        await setup.db.insert(workspaces).values({
          id: workspaceId,
          organizationId,
          name: "Rate currency serialization matter",
          reference: workspaceId,
        });
        await setup.db.insert(workspaceMembers).values({ workspaceId, userId });
        await setup.db.insert(rateTables).values({
          id: rateTableId,
          organizationId,
          workspaceId,
          name: "Default rates",
          currency: "USD",
          isDefault: true,
        });
        await setup.db.insert(rateEntries).values({
          id: rateEntryId,
          workspaceId,
          rateTableId,
          userId: null,
          role: null,
          hourlyRate: cents(10_000),
          effectiveFrom: "2026-01-01",
        });

        const entrySafeDb = createSafeDb(
          markRlsDatabase(entryClient.db),
          [workspaceId],
          organizationId,
          userId,
        );
        const tableSafeDb = createSafeDb(
          markRlsDatabase(tableClient.db),
          [workspaceId],
          organizationId,
          userId,
        );
        type EntryContext = Parameters<typeof updateRateEntry.handler>[0];
        type TableContext = Parameters<typeof updateRateTable.handler>[0];
        const updateEntry = async (
          currency: string,
          recordAuditEvent: AuditRecorder,
        ) =>
          await updateRateEntry.handler(
            withTimeBillingEnrolment(
              createTestHandlerContext<EntryContext>({
                scopedDb: NO_DB,
                audit: recordAuditEvent,
                workspaceId,
                session: { activeOrganizationId: organizationId },
                user: { id: userId },
                safeDb: entrySafeDb,
                params: { rateTableId },
                body: { id: rateEntryId, currency, hourlyRate: 25_000 },
              }),
            ),
          );
        const updateTable = async () =>
          await updateRateTable.handler(
            withTimeBillingEnrolment(
              createTestHandlerContext<TableContext>({
                scopedDb: NO_DB,
                audit: record,
                workspaceId,
                session: { activeOrganizationId: organizationId },
                user: { id: userId },
                safeDb: tableSafeDb,
                body: { id: rateTableId, currency: "JPY" },
              }),
            ),
          );
        const storedRate = async () => {
          const table = await setup.db.query.rateTables.findFirst({
            where: { id: { eq: rateTableId } },
            columns: { currency: true },
          });
          const entry = await setup.db.query.rateEntries.findFirst({
            where: { id: { eq: rateEntryId } },
            columns: { hourlyRate: true },
          });
          return { currency: table?.currency, hourlyRate: entry?.hourlyRate };
        };
        const resolvedRate = async () => {
          const rates = await setup.db.transaction(
            async (tx) =>
              await resolveRatesInTransaction({
                tx,
                workspaceId,
                lookups: [{ userId, dateWorked }],
              }),
          );
          return rates.get(rateLookupKey({ userId, dateWorked }));
        };

        expect(await updateTable()).toEqual({ id: rateTableId });
        expect(await storedRate()).toEqual({
          currency: "JPY",
          hourlyRate: cents(100),
        });
        expect(await updateEntry("USD", record)).toMatchObject({
          code: 409,
          response: { code: "rate_table_currency_changed" },
        });
        expect(await storedRate()).toEqual({
          currency: "JPY",
          hourlyRate: cents(100),
        });
        expect(await resolvedRate()).toEqual({
          currency: "JPY",
          hourlyRate: cents(100),
        });

        await setup.db
          .update(rateTables)
          .set({ currency: "USD" })
          .where(eq(rateTables.id, rateTableId));
        await setup.db
          .update(rateEntries)
          .set({ hourlyRate: cents(10_000) })
          .where(eq(rateEntries.id, rateEntryId));
        const pidRows = await tableClient.db
          .select({ pid: sql<number>`pg_backend_pid()` })
          .from(sql`(SELECT 1) AS backend_identity`);
        const tablePid =
          pidRows.at(0)?.pid ?? panic("Table backend identity missing");
        const entryPidRows = await entryClient.db
          .select({ pid: sql<number>`pg_backend_pid()` })
          .from(sql`(SELECT 1) AS backend_identity`);
        const entryPid =
          entryPidRows.at(0)?.pid ?? panic("Entry backend identity missing");
        const entryReachedAudit = Promise.withResolvers<undefined>();
        const tableStarted = Promise.withResolvers<undefined>();
        const tableBlocked = Promise.withResolvers<undefined>();
        const releaseEntry = Promise.withResolvers<undefined>();
        const gatedRecord: AuditRecorder = async () => {
          entryReachedAudit.resolve(undefined);
          await tableStarted.promise;
          await waitForBlockedPid(setup.sql, {
            waitingPid: tablePid,
            holdingPid: entryPid,
          });
          tableBlocked.resolve(undefined);
          await releaseEntry.promise;
        };
        const entryTask = updateEntry("USD", gatedRecord);
        await Promise.race([
          entryReachedAudit.promise,
          entryTask.then(() =>
            panic("Rate-entry update completed before its audit gate"),
          ),
        ]);
        const tableTask = updateTable();
        tableStarted.resolve(undefined);
        await Promise.race([
          tableBlocked.promise,
          entryTask.then(() =>
            panic("Rate-entry update failed before blocking currency change"),
          ),
        ]);
        releaseEntry.resolve(undefined);
        expect(await entryTask).toEqual({ id: rateEntryId });
        expect(await tableTask).toEqual({ id: rateTableId });
        expect(await storedRate()).toEqual({
          currency: "JPY",
          hourlyRate: cents(250),
        });
        expect(await resolvedRate()).toEqual({
          currency: "JPY",
          hourlyRate: cents(250),
        });
      } finally {
        await setup.db
          .delete(organization)
          .where(eq(organization.id, organizationId));
        await setup.db.delete(user).where(eq(user.id, userId));
      }
    });
  }, 55_000);
}
