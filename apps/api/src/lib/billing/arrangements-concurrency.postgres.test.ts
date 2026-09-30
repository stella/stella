import { panic, Result } from "better-result";
import { describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";

import { member, organization, user } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import {
  auditLogs,
  billingArrangements,
  timeEntries,
  workspaceMembers,
  workspaces,
} from "@/api/db/schema";
import { createSafeDb, markRlsDatabase } from "@/api/db/scoped";
import { createBackgroundAuditRecorder } from "@/api/lib/audit-log";
import { recordBillingCapCrossings } from "@/api/lib/billing/arrangements";
import { createSafeId } from "@/api/lib/branded-types";
import { cents } from "@/api/lib/money";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import {
  mintAuthProviderId,
  mintAuthProviderIdValue,
} from "@/api/tests/helpers/auth-provider-id";

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
  panic("Concurrent cap refresh did not reach the matter lock");
};

if (!databaseUrl || !runPostgres) {
  describe.skip("billing cap crossing serialization (postgres)", () => {
    test("requires DATABASE_URL and STELLA_RUN_POSTGRES_TESTS=true", () =>
      expect(true).toBe(true));
  });
} else {
  test("concurrent cap refreshes commit one audit event per boundary", async () => {
    await withGatedTestClients(databaseUrl, async ({ openClient }) => {
      const { db: firstDb } = openClient({ max: 1 });
      const { db: secondDb } = openClient({ max: 1 });
      const organizationId = mintAuthProviderId<"organization">();
      const userId = mintAuthProviderId<"user">();
      const workspaceId = createSafeId<"workspace">();
      const gateReached = Promise.withResolvers<undefined>();
      const secondStarted = Promise.withResolvers<undefined>();
      const release = Promise.withResolvers<undefined>();
      const blocked = Promise.withResolvers<undefined>();
      const tasks: Promise<unknown>[] = [];
      const record = createBackgroundAuditRecorder({
        organizationId,
        workspaceId,
        userId,
        execution: {
          performer: { type: "user", id: userId },
          trigger: { type: "system", source: "billing_cap_test" },
        },
      });
      try {
        await firstDb.insert(user).values({
          id: userId,
          name: "Billing test member",
          email: `${userId}@example.test`,
          emailVerified: true,
        });
        await firstDb.insert(organization).values({
          id: organizationId,
          name: "Billing test organization",
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
          name: "Billing test matter",
          reference: workspaceId,
        });
        await firstDb.insert(workspaceMembers).values({ workspaceId, userId });
        await firstDb.insert(billingArrangements).values({
          workspaceId,
          organizationId,
          mode: "hourly",
          currency: "USD",
          capAmount: cents(10_000),
          alertThresholdBps: 8000,
        });
        await firstDb.insert(timeEntries).values({
          organizationId,
          workspaceId,
          userId,
          dateWorked: "2026-10-04",
          timezoneId: "UTC",
          durationMinutes: 60,
          billedMinutes: 60,
          rateAtEntry: cents(10_000),
          currency: "USD",
          narrative: "Client work",
          status: "approved",
          billable: true,
        });
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
        const firstTask = Result.tryPromise(
          async () =>
            await firstSafe(
              async (tx) =>
                await recordBillingCapCrossings(tx, {
                  workspaceId,
                  recordAuditEvent: async (auditTx, events) => {
                    await record(auditTx, events);
                    gateReached.resolve(undefined);
                    await secondStarted.promise;
                    await observeBlocking(auditTx, pid);
                    blocked.resolve(undefined);
                    await release.promise;
                  },
                }),
            ),
        );
        tasks.push(firstTask);
        await Promise.race([
          gateReached.promise,
          firstTask.then(() =>
            panic("First refresh finished before reaching its audit gate"),
          ),
        ]);
        const secondTask = Result.tryPromise(
          async () =>
            await secondSafe(
              async (tx) =>
                await recordBillingCapCrossings(tx, {
                  workspaceId,
                  recordAuditEvent: record,
                }),
            ),
        );
        tasks.push(secondTask);
        secondStarted.resolve(undefined);
        await Promise.race([
          blocked.promise,
          firstTask.then(() =>
            panic("First refresh finished before observing its competitor"),
          ),
        ]);
        release.resolve(undefined);
        const results = await Promise.all([firstTask, secondTask]);
        for (const result of results) {
          expect(result.isOk()).toBe(true);
          if (result.isOk()) {
            expect(result.value.isOk()).toBe(true);
          }
        }
        const events = await firstDb
          .select({ metadata: auditLogs.metadata })
          .from(auditLogs)
          .where(eq(auditLogs.workspaceId, workspaceId));
        expect(events).toHaveLength(2);
        expect(
          events.map((event) => event.metadata?.["boundary"]).toSorted(),
        ).toEqual(["cap", "threshold"]);
        const rows = await firstDb
          .select()
          .from(billingArrangements)
          .where(eq(billingArrangements.workspaceId, workspaceId));
        expect(rows.at(0)).toMatchObject({
          thresholdState: "above",
          capState: "above",
          crossingSequence: 2,
        });
      } finally {
        gateReached.resolve(undefined);
        secondStarted.resolve(undefined);
        release.resolve(undefined);
        blocked.resolve(undefined);
        await Promise.allSettled(tasks);
        await firstDb
          .delete(organization)
          .where(eq(organization.id, organizationId));
        await firstDb.delete(user).where(eq(user.id, userId));
      }
    });
  }, 30_000);
}
