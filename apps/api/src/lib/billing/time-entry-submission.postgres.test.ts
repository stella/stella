import { Result } from "better-result";
import { describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";

import { Temporal } from "@stll/time";

import { member, organization, user } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import type { SafeDb } from "@/api/db/safe-db";
import {
  auditLogs,
  featureEnrolments,
  TIME_ENTRY_SOURCE,
  timeEntries,
  timeTimers,
  workspaces,
} from "@/api/db/schema";
import resumeTimer from "@/api/handlers/time-timers/resume";
import { createBackgroundAuditRecorder } from "@/api/lib/audit-log";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { timeEntryIsRunning } from "@/api/lib/billing/time-entry-running";
import { submitTimeEntries } from "@/api/lib/billing/time-entry-submission";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { cents } from "@/api/lib/money";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import {
  type GatedTestDb,
  withGatedTestClients,
} from "@/api/tests/gated-test-database";
import {
  mintAuthProviderId,
  mintAuthProviderIdValue,
} from "@/api/tests/helpers/auth-provider-id";
import {
  createTestHandlerContext,
  NO_DB,
} from "@/api/tests/helpers/handler-context";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { enrolledTimeBillingSnapshot } from "@/api/tests/helpers/time-billing-enrolment";
import {
  type InterleavingResult,
  withInterleaving,
} from "@/api/tests/helpers/transaction-interleaving";

const databaseUrl = process.env["DATABASE_URL"];
const runPostgres = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

type Fixture = {
  db: GatedTestDb;
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  workspaceId: SafeId<"workspace">;
  entryId: SafeId<"timeEntry">;
  day: string;
  recordAuditEvent: AuditRecorder;
};

// One owner, one matter and one draft of yesterday the owner approves.
const withFixture = async (
  url: string,
  entry: Partial<typeof timeEntries.$inferInsert>,
  run: (fixture: Fixture) => Promise<void>,
) =>
  await withGatedTestClients(url, async ({ openClient }) => {
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
      await db
        .insert(featureEnrolments)
        .values({ organizationId, userId, featureId: "time-billing" });
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
        ...entry,
      });
      await run({
        db,
        organizationId,
        userId,
        workspaceId,
        entryId,
        day,
        recordAuditEvent,
      });
    } finally {
      await db.delete(organization).where(eq(organization.id, organizationId));
      await db.delete(user).where(eq(user.id, userId));
    }
  });

// Runs the code under test inside the interleaving's own transaction and
// answers as safeDb does: the callback's value wrapped in an ok result.
const inTransaction = (tx: Transaction) =>
  asTestRaw<SafeDb>(async (run: (current: Transaction) => Promise<unknown>) =>
    Result.ok(await run(tx)),
  );

const submitStep = (fixture: Fixture, approve: boolean) => ({
  name: "submit",
  run: async (tx: Transaction) => {
    const outcome = await submitTimeEntries({
      safeDb: inTransaction(tx),
      organizationId: fixture.organizationId,
      userId: fixture.userId,
      memberRole: sessionMemberRole("owner"),
      startDate: fixture.day,
      endDate: fixture.day,
      approve,
      recordAuditEvent: fixture.recordAuditEvent,
    });
    expect(outcome.isOk()).toBe(true);
  },
});

// Resumed, or refused because the submit came first; anything else verbatim.
const resumeAnswer = (answer: unknown) => {
  const text = JSON.stringify(answer);
  if (text.includes("timer_original_entry_changed")) {
    return "refused";
  }
  return text.includes('"state":"running"') ? "resumed" : text;
};

const COMMITTED: InterleavingResult<unknown>["outcomes"] = {
  a: { status: "committed" },
  b: { status: "committed" },
};

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
    await withFixture(databaseUrl, {}, async (fixture) => {
      const { db, entryId, workspaceId } = fixture;
      const results = await withInterleaving({
        databaseUrl,
        a: { steps: [submitStep(fixture, true)] },
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
            .where(eq(auditLogs.organizationId, fixture.organizationId));
          await db
            .update(timeEntries)
            .set({ status: "draft", approvedByUserId: null, approvedAt: null })
            .where(eq(timeEntries.id, entryId));
        },
        readState: async () =>
          await db
            .select({ status: timeEntries.status })
            .from(timeEntries)
            .where(eq(timeEntries.id, entryId)),
        invariant: ({ outcomes, state }) => {
          expect(outcomes).toEqual(COMMITTED);
          expect(state).toEqual([{ status: "approved" }]);
        },
      });
      expect(results).toHaveLength(10);
      // The matter lock held by the edit made the submit wait in some order.
      expect(results.some(({ blocked }) => blocked.includes("a.submit"))).toBe(
        true,
      );
    });
  }, 60_000); // timeout: ten interleavings, each with its own pair of real Postgres sessions and lock waits

  // A migrated timer runs on its original draft. Submitting that draft while
  // its paused timer resumes must end with exactly one of them: a submitted
  // entry with no running timer, or a running draft the submit refused.
  test("submitting a week and resuming its paused linked timer never leave a submitted entry running", async () => {
    await withFixture(
      databaseUrl,
      {
        source: TIME_ENTRY_SOURCE.TIMER,
        timerStartedAt: new Date(Date.now() - 3_600_000),
      },
      async (fixture) => {
        const { db, entryId, organizationId, userId, workspaceId } = fixture;
        const timerId = createSafeId<"timeTimer">();
        await db.insert(timeTimers).values({
          id: timerId,
          organizationId,
          workspaceId,
          userId,
          legacyTimeEntryId: entryId,
          description: "Client work",
          state: "paused",
          startedAt: new Date(Date.now() - 3_600_000),
          accumulatedSeconds: 60,
          lastResumedAt: null,
        });
        const answers: string[] = [];
        const results = await withInterleaving({
          databaseUrl,
          a: { steps: [submitStep(fixture, false)] },
          b: {
            steps: [
              {
                name: "resume",
                run: async (tx: Transaction) => {
                  const answer = await resumeTimer.handler(
                    createTestHandlerContext<
                      Parameters<typeof resumeTimer.handler>[0]
                    >({
                      safeDb: inTransaction(tx),
                      scopedDb: NO_DB,
                      audit: fixture.recordAuditEvent,
                      workspaceId,
                      memberRole: sessionMemberRole("owner"),
                      session: { activeOrganizationId: organizationId },
                      user: { id: userId },
                      featureAccessSnapshot: enrolledTimeBillingSnapshot({
                        organizationId,
                        userId,
                      }),
                      params: { id: timerId },
                    }),
                  );
                  answers.push(resumeAnswer(answer));
                },
              },
            ],
          },
          reset: async () => {
            await db
              .delete(auditLogs)
              .where(eq(auditLogs.organizationId, organizationId));
            await db
              .update(timeTimers)
              .set({ state: "paused", lastResumedAt: null })
              .where(eq(timeTimers.id, timerId));
            await db
              .update(timeEntries)
              .set({ status: "draft" })
              .where(eq(timeEntries.id, entryId));
          },
          readState: async () =>
            await db
              .select({
                status: timeEntries.status,
                running: timeEntryIsRunning(),
              })
              .from(timeEntries)
              .where(eq(timeEntries.id, entryId)),
          invariant: ({ outcomes, state }) => {
            expect(outcomes).toEqual(COMMITTED);
            expect([
              [{ status: "submitted", running: false }],
              [{ status: "draft", running: true }],
            ]).toContainEqual(state);
          },
        });
        // Two steps and two commits: six orders.
        expect(results).toHaveLength(6);
        expect(new Set(answers)).toEqual(new Set(["resumed", "refused"]));
      },
    );
  }, 60_000); // timeout: six interleavings, each with its own pair of real Postgres sessions and lock waits
}
