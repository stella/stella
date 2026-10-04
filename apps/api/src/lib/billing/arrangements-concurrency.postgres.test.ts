import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

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
import { withInterleaving } from "@/api/tests/helpers/transaction-interleaving";

const databaseUrl = process.env["DATABASE_URL"];
const runPostgres = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

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
        const participant = (safeDb: typeof firstSafe) => ({
          transaction: async <T>(run: (tx: Transaction) => Promise<T>) =>
            (
              await safeDb(run, {
                retry: { times: 0, delayMs: 0, backoff: "constant" },
              })
            ).unwrap(),
          steps: [
            {
              name: "refresh",
              run: async (tx: Transaction) => {
                await recordBillingCapCrossings(tx, {
                  workspaceId,
                  recordAuditEvent: record,
                });
              },
            },
          ],
        });
        let invariantCalls = 0;
        const results = await withInterleaving({
          databaseUrl,
          a: participant(firstSafe),
          b: participant(secondSafe),
          reset: async () => {
            await firstDb
              .delete(auditLogs)
              .where(eq(auditLogs.workspaceId, workspaceId));
            await firstDb
              .update(billingArrangements)
              .set({
                thresholdState: "below",
                capState: "below",
                crossingSequence: 0,
              })
              .where(eq(billingArrangements.workspaceId, workspaceId));
          },
          readState: async () =>
            await firstDb
              .select()
              .from(billingArrangements)
              .where(eq(billingArrangements.workspaceId, workspaceId)),
          invariant: async ({ outcomes, state }) => {
            invariantCalls += 1;
            expect(outcomes).toEqual({
              a: { status: "committed" },
              b: { status: "committed" },
            });
            expect(state.at(0)).toMatchObject({
              thresholdState: "above",
              capState: "above",
              crossingSequence: 2,
            });
            const events = await firstDb
              .select({ metadata: auditLogs.metadata })
              .from(auditLogs)
              .where(eq(auditLogs.workspaceId, workspaceId));
            expect(events).toHaveLength(2);
            expect(
              events
                .map((event) => {
                  const boundary = event.metadata?.["boundary"];
                  if (typeof boundary !== "string") {
                    panic("Crossing audit boundary missing");
                  }
                  return boundary;
                })
                .toSorted((left, right) => {
                  if (left === right) {
                    return 0;
                  }
                  return left < right ? -1 : 1;
                }),
            ).toEqual(["cap", "threshold"]);
          },
        });
        expect(results).toHaveLength(6);
        expect(invariantCalls).toBe(results.length);
        expect(results.some(({ blocked }) => blocked.length > 0)).toBe(true);
      } finally {
        await firstDb
          .delete(organization)
          .where(eq(organization.id, organizationId));
        await firstDb.delete(user).where(eq(user.id, userId));
      }
    });
  }, 30_000);
}
