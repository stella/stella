import { describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";

import { Temporal } from "@stll/time";

import { member, organization, user } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import type { SafeDb } from "@/api/db/safe-db";
import { auditLogs, timeEntries, workspaces } from "@/api/db/schema";
import { createBackgroundAuditRecorder } from "@/api/lib/audit-log";
import { submitTimeEntries } from "@/api/lib/billing/time-entry-submission";
import { createSafeId } from "@/api/lib/branded-types";
import { cents } from "@/api/lib/money";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import {
  mintAuthProviderId,
  mintAuthProviderIdValue,
} from "@/api/tests/helpers/auth-provider-id";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { withInterleaving } from "@/api/tests/helpers/transaction-interleaving";

const databaseUrl = process.env["DATABASE_URL"];
const runPostgres = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

if (!databaseUrl || !runPostgres) {
  describe.skip("submitting and approving a week (postgres)", () => {
    test("requires DATABASE_URL and STELLA_RUN_POSTGRES_TESTS=true", () =>
      expect(true).toBe(true));
  });
} else {
  // An entry edit takes the matter lock, then the entry row. Submitting with
  // approve reconciles the matter's billing cap under that same matter lock,
  // so it must take the matter lock before it holds any entry row; otherwise
  // the two wait on each other.
  test("approving one's own week and editing its entry never deadlock", async () => {
    await withGatedTestClients(databaseUrl, async ({ openClient }) => {
      const { db } = openClient({ max: 1 });
      const organizationId = mintAuthProviderId<"organization">();
      const userId = mintAuthProviderId<"user">();
      const workspaceId = createSafeId<"workspace">();
      const entryId = createSafeId<"timeEntry">();
      const day = Temporal.Now.plainDateISO("UTC")
        .subtract({ days: 1 })
        .toString();
      const recordAuditEvent = createBackgroundAuditRecorder({
        organizationId,
        workspaceId: null,
        userId,
        execution: {
          performer: { type: "user", id: userId },
          trigger: { type: "system", source: "time_submission_lock_test" },
        },
      });
      try {
        await db.insert(user).values({
          id: userId,
          name: "Submission test member",
          email: `${userId}@example.test`,
          emailVerified: true,
        });
        await db.insert(organization).values({
          id: organizationId,
          name: "Submission test organization",
          slug: organizationId,
          createdAt: new Date(),
        });
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
          name: "Submission test matter",
          reference: workspaceId,
        });
        await db.insert(timeEntries).values({
          id: entryId,
          organizationId,
          workspaceId,
          userId,
          approverUserId: userId,
          dateWorked: day,
          timezoneId: "UTC",
          durationMinutes: 60,
          billedMinutes: 60,
          rateAtEntry: cents(10_000),
          currency: "USD",
          narrative: "Client work",
          billable: true,
        });
        const inTransaction = (tx: Transaction) =>
          asTestRaw<SafeDb>(
            async (run: (current: Transaction) => Promise<unknown>) =>
              await run(tx),
          );
        const results = await withInterleaving({
          databaseUrl,
          a: {
            steps: [
              {
                name: "submit",
                run: async (tx: Transaction) => {
                  const outcome = await submitTimeEntries({
                    safeDb: inTransaction(tx),
                    organizationId,
                    userId,
                    memberRole: sessionMemberRole("owner"),
                    startDate: day,
                    endDate: day,
                    approve: true,
                    recordAuditEvent,
                  });
                  expect(outcome.isOk()).toBe(true);
                },
              },
            ],
          },
          b: {
            steps: [
              {
                name: "matter",
                run: async (tx: Transaction) =>
                  await tx.execute(
                    sql`SELECT pg_advisory_xact_lock(hashtext(${workspaceId}))`,
                  ),
              },
              {
                name: "entry",
                run: async (tx: Transaction) =>
                  await tx
                    .select({ id: timeEntries.id })
                    .from(timeEntries)
                    .where(eq(timeEntries.id, entryId))
                    .for("update"),
              },
            ],
          },
          reset: async () => {
            await db
              .delete(auditLogs)
              .where(eq(auditLogs.organizationId, organizationId));
            await db
              .update(timeEntries)
              .set({
                status: "draft",
                approvedByUserId: null,
                approvedAt: null,
              })
              .where(eq(timeEntries.id, entryId));
          },
          readState: async () =>
            await db
              .select({ status: timeEntries.status })
              .from(timeEntries)
              .where(eq(timeEntries.id, entryId)),
          invariant: ({ outcomes, state }) => {
            expect(outcomes).toEqual({
              a: { status: "committed" },
              b: { status: "committed" },
            });
            expect(state).toEqual([{ status: "approved" }]);
          },
        });
        expect(results).toHaveLength(10);
        // The matter lock held by the edit made the submit wait in some order.
        expect(
          results.some(({ blocked }) => blocked.includes("a.submit")),
        ).toBe(true);
      } finally {
        await db
          .delete(organization)
          .where(eq(organization.id, organizationId));
        await db.delete(user).where(eq(user.id, userId));
      }
    });
  }, 60_000); // timeout: ten interleavings, each with its own pair of real Postgres sessions and lock waits
}
