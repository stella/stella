import {
  afterAll,
  beforeAll,
  beforeEach,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { eq, inArray } from "drizzle-orm";
import { ElysiaCustomStatusResponse } from "elysia/error";

import { user as authUser } from "@/api/db/auth-schema";
import {
  BILLING_STATUS,
  timeEntries,
  timeTimers,
  featureEnrolments,
} from "@/api/db/schema";
import { createSafeDb, createScopedDb } from "@/api/db/scoped";
import type { AuditEvent } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import { cents } from "@/api/lib/money";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  createTestIds,
  setupRlsTestData,
} from "@/api/tests/security/rls-helpers";
import { getTestDb, releaseTestDb } from "@/api/tests/security/test-utils";
import type { TestDatabase } from "@/api/tests/security/test-utils";

import batchUpdate from "./update";

setDefaultTimeout(120_000);
const ids = createTestIds();
let db: TestDatabase;
const createdEntryIds: (typeof timeEntries.$inferSelect.id)[] = [];
const START = new Date("2026-09-01T10:00:00Z");
type BatchContext = Parameters<typeof batchUpdate.handler>[0];

beforeAll(async () => {
  db = await getTestDb();
  await setupRlsTestData(db, ids);

  await db
    .update(authUser)
    .set({ emailVerified: true })
    .where(inArray(authUser.id, [ids.userAdmin]));
  await db
    .insert(featureEnrolments)
    .values([
      {
        organizationId: ids.orgA,
        userId: ids.userAdmin,
        featureId: "time-billing",
      },
    ])
    .onConflictDoNothing();
});
beforeEach(async () => {
  await db.delete(timeTimers).where(eq(timeTimers.organizationId, ids.orgA));
  if (createdEntryIds.length > 0) {
    await db
      .delete(timeEntries)
      .where(inArray(timeEntries.id, createdEntryIds.splice(0)));
  }
});
afterAll(async () => {
  await releaseTestDb();
});

const createEntry = async (timer: "none" | "running" | "stopped" = "none") => {
  const id = createSafeId<"timeEntry">();
  await db.insert(timeEntries).values({
    id,
    organizationId: ids.orgA,
    userId: ids.userAdmin,
    workspaceId: ids.wsA2,
    dateWorked: "2026-09-01",
    timezoneId: "UTC",
    durationMinutes: 30,
    billedMinutes: 30,
    narrative: "Recorded work",
    rateAtEntry: cents(0),
    currency: "USD",
    billable: false,
    timerStartedAt: timer === "none" ? null : START,
    timerStoppedAt: timer === "stopped" ? START : null,
  });
  createdEntryIds.push(id);
  return id;
};

const runBatch = async (
  body: BatchContext["body"],
  events: AuditEvent[] = [],
) =>
  await batchUpdate.handler(
    asTestRaw<BatchContext>({
      request: new Request("https://example.test/time-entries/batch", {
        method: "PATCH",
      }),
      route: "/time-entries/batch",
      body,
      memberRole: sessionMemberRole("owner"),
      session: { activeOrganizationId: ids.orgA },
      user: { id: ids.userAdmin },
      workspaceId: ids.wsA2,
      safeDb: createSafeDb(db, [ids.wsA2], ids.orgA, ids.userAdmin),
      scopedDb: createScopedDb(db, [ids.wsA2], ids.orgA, ids.userAdmin),
      recordAuditEvent: (async (_tx, event) => {
        events.push(...(Array.isArray(event) ? event : [event]));
      }) satisfies BatchContext["recordAuditEvent"],
    }),
  );

const readEntry = async (id: typeof timeEntries.$inferSelect.id) =>
  (await db.select().from(timeEntries).where(eq(timeEntries.id, id))).at(0);

test("approval records its actor and time, clears return provenance, and revert clears approval provenance", async () => {
  const id = await createEntry();
  await db
    .update(timeEntries)
    .set({
      returnedByUserId: ids.userA1,
      returnedAt: START,
      returnComment: "Clarify recorded work",
    })
    .where(eq(timeEntries.id, id));
  const events: AuditEvent[] = [];
  const before = new Date();
  expect(await runBatch({ ids: [id], action: "approve" }, events)).toEqual({
    updated: 1,
  });
  const approved = await readEntry(id);
  expect(approved).toMatchObject({
    status: BILLING_STATUS.APPROVED,
    approvedByUserId: ids.userAdmin,
    returnedByUserId: null,
    returnedAt: null,
    returnComment: null,
  });
  expect(approved?.approvedAt?.getTime()).toBeGreaterThanOrEqual(
    before.getTime(),
  );
  expect(approved?.approvedAt?.getTime()).toBeLessThanOrEqual(Date.now());
  expect(
    await runBatch({ ids: [id], action: "revert_to_draft" }, events),
  ).toEqual({ updated: 1 });
  expect(await readEntry(id)).toMatchObject({
    status: BILLING_STATUS.DRAFT,
    approvedByUserId: null,
    approvedAt: null,
  });
  expect(events).toHaveLength(2);
  expect(events.at(0)?.changes).toHaveProperty("status", {
    old: BILLING_STATUS.DRAFT,
    new: BILLING_STATUS.APPROVED,
  });
  expect(events.at(1)?.changes).toHaveProperty("status", {
    old: BILLING_STATUS.APPROVED,
    new: BILLING_STATUS.DRAFT,
  });
});

test("approval accepts stopped legacy timers and paused linked timers despite a persisted start timestamp", async () => {
  const stoppedId = await createEntry("stopped");
  expect((await readEntry(stoppedId))?.timerStartedAt).toEqual(
    expect.any(Date),
  );
  expect(await runBatch({ ids: [stoppedId], action: "approve" })).toEqual({
    updated: 1,
  });
  expect(await readEntry(stoppedId)).toMatchObject({
    status: BILLING_STATUS.APPROVED,
  });
  await db.delete(timeEntries).where(eq(timeEntries.id, stoppedId));
  const pausedId = await createEntry("running");
  const timerId = createSafeId<"timeTimer">();
  await db.insert(timeTimers).values({
    id: timerId,
    organizationId: ids.orgA,
    userId: ids.userAdmin,
    workspaceId: ids.wsA2,
    legacyTimeEntryId: pausedId,
    state: "paused",
    startedAt: START,
    lastResumedAt: null,
  });
  expect((await readEntry(pausedId))?.timerStartedAt).toEqual(expect.any(Date));
  expect(await runBatch({ ids: [pausedId], action: "approve" })).toEqual({
    updated: 1,
  });
  expect(await readEntry(pausedId)).toMatchObject({
    status: BILLING_STATUS.APPROVED,
  });
});

test("approval refuses its actor's direct and projected running timers without approving any selected row", async () => {
  const readyId = await createEntry();
  const directId = await createEntry("running");
  const projectedId = await createEntry();
  await db.insert(timeTimers).values({
    id: createSafeId<"timeTimer">(),
    organizationId: ids.orgA,
    userId: ids.userAdmin,
    workspaceId: ids.wsA2,
    legacyTimeEntryId: projectedId,
    state: "running",
    startedAt: START,
    lastResumedAt: START,
  });
  for (const runningId of [directId, projectedId]) {
    const events: AuditEvent[] = [];
    const result = await runBatch(
      { ids: [readyId, runningId], action: "approve" },
      events,
    );
    expect(result).toBeInstanceOf(ElysiaCustomStatusResponse);
    if (result instanceof ElysiaCustomStatusResponse) {
      expect(result.code).toBe(400);
      expect(result.response).toMatchObject({
        message: "Stop running timers before approval",
      });
    }
    expect(await readEntry(runningId)).toMatchObject({
      status: BILLING_STATUS.DRAFT,
      approvedByUserId: null,
      approvedAt: null,
    });
    expect(await readEntry(readyId)).toMatchObject({
      status: BILLING_STATUS.DRAFT,
    });
    expect(events).toEqual([]);
  }
});

test("every batch action preserves billed and written-off entries and their approval provenance", async () => {
  const billedId = await createEntry();
  const writtenOffId = await createEntry();
  await db
    .update(timeEntries)
    .set({
      status: BILLING_STATUS.BILLED,
      approvedByUserId: ids.userAdmin,
      approvedAt: START,
    })
    .where(eq(timeEntries.id, billedId));
  await db
    .update(timeEntries)
    .set({ status: BILLING_STATUS.WRITTEN_OFF })
    .where(eq(timeEntries.id, writtenOffId));
  const before = [await readEntry(billedId), await readEntry(writtenOffId)];
  const actions = [
    "approve",
    "revert_to_draft",
    "mark_billable",
    "mark_non_billable",
  ] as const satisfies readonly BatchContext["body"]["action"][];
  const events: AuditEvent[] = [];
  for (const action of actions) {
    expect(
      await runBatch({ ids: [billedId, writtenOffId], action }, events),
    ).toEqual({
      updated: 0,
    });
    expect([await readEntry(billedId), await readEntry(writtenOffId)]).toEqual(
      before,
    );
  }
  expect(events).toEqual([]);
});
