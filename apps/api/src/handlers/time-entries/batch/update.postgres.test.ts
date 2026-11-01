import { describe, expect, test } from "bun:test";
import { and, eq, inArray, or } from "drizzle-orm";

import { Temporal } from "@stll/time";

import { member, organization, user } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import {
  BILLING_STATUS,
  featureEnrolments,
  ORGANIZATION_ACCESS_STATE,
  organizationAccessStates,
  timeEntries,
  workspaceMembers,
  workspaces,
} from "@/api/db/schema";
import { createSafeDb, markRlsDatabase } from "@/api/db/scoped";
import type { AuditEvent } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { lockRowsForWrite } from "@/api/lib/db/aggregate-lock";
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
import {
  pauseBeforeWrite,
  safeDbIn,
  withLockThenWriteRace,
} from "@/api/tests/helpers/lock-then-write-race";
import { enrolledTimeBillingSnapshot } from "@/api/tests/helpers/time-billing-enrolment";

import batchUpdate from "./update";

const databaseUrl = process.env["DATABASE_URL"];
const runPostgres = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

type BatchContext = Parameters<typeof batchUpdate.handler>[0];

type Fixture = {
  /** The database owner: seeds rows and plays tx B. */
  db: GatedTestDb;
  /** One connection per transaction in the race. */
  actors: Record<"a" | "b", GatedTestDb>;
  organizationId: SafeId<"organization">;
  approverId: SafeId<"user">;
  workspaceId: SafeId<"workspace">;
  /** Submitted when tx A locks: approvable, so A locks and checks it. */
  submittedId: SafeId<"timeEntry">;
  /** Another timekeeper's draft when tx A locks: not approvable. */
  draftId: SafeId<"timeEntry">;
  /** Requested but not stored yet when tx A locks; tx B adds it submitted. */
  lateId: SafeId<"timeEntry">;
  timekeeperId: SafeId<"user">;
  day: string;
};

// One billable hour of the timekeeper's work on the matter.
const entryRow = (
  fixture: Omit<Fixture, "db" | "actors">,
  id: SafeId<"timeEntry">,
  status: (typeof BILLING_STATUS)[keyof typeof BILLING_STATUS],
) => ({
  id,
  status,
  organizationId: fixture.organizationId,
  workspaceId: fixture.workspaceId,
  userId: fixture.timekeeperId,
  approverUserId: fixture.approverId,
  dateWorked: fixture.day,
  timezoneId: "UTC",
  durationMinutes: 60,
  billedMinutes: 60,
  rateAtEntry: cents(10_000),
  currency: "USD",
  narrative: "Client work",
  billable: true,
});

// One matter with an owner who approves and a timekeeper whose entries are
// approved: one submitted entry and one draft.
const withFixture = async (
  url: string,
  run: (fixture: Fixture) => Promise<void>,
) =>
  await withGatedTestClients(url, async ({ openClient }) => {
    const { db } = openClient({ max: 1 });
    const actors = {
      a: openClient({ max: 1 }).db,
      b: openClient({ max: 1 }).db,
    };
    const organizationId = mintAuthProviderId<"organization">();
    const approverId = mintAuthProviderId<"user">();
    const timekeeperId = mintAuthProviderId<"user">();
    const workspaceId = createSafeId<"workspace">();
    const submittedId = createSafeId<"timeEntry">();
    const draftId = createSafeId<"timeEntry">();
    const lateId = createSafeId<"timeEntry">();
    const day = Temporal.Now.plainDateISO("UTC")
      .subtract({ days: 1 })
      .toString();
    try {
      await db.insert(user).values(
        [approverId, timekeeperId].map((id) => ({
          id,
          name: "Batch approval race member",
          email: `${id}@example.test`,
          emailVerified: true,
        })),
      );
      await db.insert(organization).values({
        id: organizationId,
        name: "Batch approval race organization",
        slug: organizationId,
        createdAt: new Date(),
      });
      await db.insert(organizationAccessStates).values({
        organizationId,
        state: ORGANIZATION_ACCESS_STATE.selfManagedKeys,
      });
      await db.insert(member).values([
        {
          id: mintAuthProviderIdValue(),
          organizationId,
          userId: approverId,
          role: "owner",
          createdAt: new Date(),
        },
        {
          id: mintAuthProviderIdValue(),
          organizationId,
          userId: timekeeperId,
          role: "member",
          createdAt: new Date(),
        },
      ]);
      await db.insert(featureEnrolments).values({
        organizationId,
        userId: approverId,
        featureId: "time-billing",
      });
      await db.insert(workspaces).values({
        id: workspaceId,
        organizationId,
        name: "Batch approval race matter",
        reference: workspaceId,
      });
      await db.insert(workspaceMembers).values([
        { workspaceId, userId: approverId },
        { workspaceId, userId: timekeeperId },
      ]);
      const fixture = {
        db,
        actors,
        organizationId,
        approverId,
        workspaceId,
        submittedId,
        draftId,
        lateId,
        timekeeperId,
        day,
      };
      await db
        .insert(timeEntries)
        .values([
          entryRow(fixture, submittedId, BILLING_STATUS.SUBMITTED),
          entryRow(fixture, draftId, BILLING_STATUS.DRAFT),
        ]);
      await run(fixture);
    } finally {
      await db.delete(organization).where(eq(organization.id, organizationId));
      await db.delete(user).where(inArray(user.id, [approverId, timekeeperId]));
    }
  });

// Tx A runs as the application role scoped to the approver, as a request does.
const asApprover = (fixture: Fixture) => {
  const safeDb = createSafeDb(
    markRlsDatabase(fixture.actors.a),
    [fixture.workspaceId],
    fixture.organizationId,
    fixture.approverId,
  );
  return async <T>(run: (tx: Transaction) => Promise<T>) =>
    (
      await safeDb(run, {
        retry: { times: 0, delayMs: 0, backoff: "constant" },
      })
    ).unwrap();
};

// Tx B: the timekeeper submits the draft, which makes it approvable.
const submitDraft = (fixture: Fixture) => async (tx: Transaction) =>
  await tx
    .update(timeEntries)
    .set({ status: BILLING_STATUS.SUBMITTED })
    .where(eq(timeEntries.id, fixture.draftId))
    .returning({ id: timeEntries.id });

// Tx B: an entry, already submitted, stored under an id tx A's request names
// after A's lock. This is not a race a live request can hit: the approval's
// running-entry guard locks every requested entry that exists, and entry ids
// are minted by the server. It proves the approval write is pinned to the
// rows it locked and checked (defense in depth), so it cannot reach a row
// that only matched afterwards, however that row got there.
const recordLateEntry = (fixture: Fixture) => async (tx: Transaction) =>
  await tx
    .insert(timeEntries)
    .values(entryRow(fixture, fixture.lateId, BILLING_STATUS.SUBMITTED))
    .returning({ id: timeEntries.id });

const statuses = async ({ db, submittedId, draftId, lateId }: Fixture) =>
  Object.fromEntries(
    (
      await db
        .select({ id: timeEntries.id, status: timeEntries.status })
        .from(timeEntries)
        .where(inArray(timeEntries.id, [submittedId, draftId, lateId]))
    ).map(({ id, status }) => [id, status]),
  );

// The batch approval's own selection of approvable entries.
const approvable = (fixture: Fixture) =>
  and(
    eq(timeEntries.workspaceId, fixture.workspaceId),
    inArray(timeEntries.id, [fixture.submittedId, fixture.draftId]),
    or(
      eq(timeEntries.status, BILLING_STATUS.SUBMITTED),
      and(
        eq(timeEntries.status, BILLING_STATUS.DRAFT),
        eq(timeEntries.userId, fixture.approverId),
      ),
    ),
  );

if (!databaseUrl || !runPostgres) {
  describe.skip("batch approval racing a submit (postgres)", () => {
    test("requires DATABASE_URL and STELLA_RUN_POSTGRES_TESTS=true", () =>
      expect(true).toBe(true));
  });
} else {
  describe("batch approval racing a submit (postgres)", () => {
    test("approves only the entries it locked, not one recorded after the lock", async () => {
      await withFixture(databaseUrl, async (fixture) => {
        const events: AuditEvent[] = [];
        const race = await withLockThenWriteRace({
          transactions: {
            a: asApprover(fixture),
            b: async (run) => await fixture.actors.b.transaction(run),
          },
          a: async (tx, pause) =>
            await batchUpdate.handler(
              createTestHandlerContext<BatchContext>({
                safeDb: safeDbIn(pauseBeforeWrite(tx, timeEntries, pause)),
                scopedDb: NO_DB,
                audit: async (_tx, event) => {
                  events.push(...(Array.isArray(event) ? event : [event]));
                },
                workspaceId: fixture.workspaceId,
                memberRole: sessionMemberRole("owner"),
                session: { activeOrganizationId: fixture.organizationId },
                user: { id: fixture.approverId },
                featureAccessSnapshot: enrolledTimeBillingSnapshot({
                  organizationId: fixture.organizationId,
                  userId: fixture.approverId,
                }),
                body: {
                  ids: [fixture.submittedId, fixture.draftId, fixture.lateId],
                  action: "approve",
                },
              }),
            ),
          b: recordLateEntry(fixture),
        });

        // Tx B's entry was committed before tx A wrote.
        expect(race.b).toEqual([{ id: fixture.lateId }]);
        expect(race.a).toEqual({ updated: 1 });
        expect(await statuses(fixture)).toEqual({
          [fixture.submittedId]: BILLING_STATUS.APPROVED,
          [fixture.draftId]: BILLING_STATUS.DRAFT,
          [fixture.lateId]: BILLING_STATUS.SUBMITTED,
        });
        expect(events.map(({ resourceId }) => resourceId)).toEqual([
          fixture.submittedId,
        ]);
      });
    }, 30_000); // timeout: two real Postgres sessions plus fixture setup

    // The harness is only evidence if the order it forces reaches a write
    // that repeats the lock's WHERE. The same race with that write approves
    // the late entry; the locked-rows write from the same lock does not.
    test("the race reaches a write that repeats the lock's WHERE", async () => {
      await withFixture(databaseUrl, async (fixture) => {
        const rederived = await withLockThenWriteRace({
          transactions: {
            a: asApprover(fixture),
            b: async (run) => await fixture.actors.b.transaction(run),
          },
          a: async (tx, pause) => {
            await lockRowsForWrite({
              table: timeEntries,
              query: tx
                .select({ id: timeEntries.id })
                .from(timeEntries)
                .where(approvable(fixture))
                .limit(2),
            });
            await pause();
            return await tx
              .update(timeEntries)
              .set({ status: BILLING_STATUS.APPROVED })
              .where(approvable(fixture))
              .returning({ id: timeEntries.id });
          },
          b: submitDraft(fixture),
        });
        expect(new Set(rederived.a.map(({ id }) => id))).toEqual(
          new Set([fixture.submittedId, fixture.draftId]),
        );
      });
      await withFixture(databaseUrl, async (fixture) => {
        const pinned = await withLockThenWriteRace({
          transactions: {
            a: asApprover(fixture),
            b: async (run) => await fixture.actors.b.transaction(run),
          },
          a: async (tx, pause) => {
            const locked = await lockRowsForWrite({
              table: timeEntries,
              query: tx
                .select({ id: timeEntries.id })
                .from(timeEntries)
                .where(approvable(fixture))
                .limit(2),
            });
            await pause();
            return await tx
              .update(timeEntries)
              .set({ status: BILLING_STATUS.APPROVED })
              .where(locked.where())
              .returning({ id: timeEntries.id });
          },
          b: submitDraft(fixture),
        });
        expect(pinned.a).toEqual([{ id: fixture.submittedId }]);
      });
    }, 30_000); // timeout: two races, each with two real Postgres sessions
  });
}
