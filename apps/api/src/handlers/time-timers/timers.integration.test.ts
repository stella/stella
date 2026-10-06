import type { TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
  setSystemTime,
  test,
} from "bun:test";
import { and, eq, inArray } from "drizzle-orm";

import { TIME_ENTRY_ACTIVITY_GROUP } from "@stll/api-contract";

import { user as authUser } from "@/api/db/auth-schema";
import type { SafeDb, ScopedDb } from "@/api/db/safe-db";
import {
  BILLING_STATUS,
  TIME_ENTRY_SOURCE,
  organizationSettings,
  rateTables,
  timeEntries,
  timeTimers,
  workspaceMembers,
  workspaces,
  featureEnrolments,
} from "@/api/db/schema";
import { createSafeDb, createScopedDb } from "@/api/db/scoped";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import { cents } from "@/api/lib/money";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import { createTestHandlerContext } from "@/api/tests/helpers/handler-context";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  createTestIds,
  setupRlsTestData,
} from "@/api/tests/security/rls-helpers";
import { getTestDb, releaseTestDb } from "@/api/tests/security/test-utils";
import type { TestDatabase } from "@/api/tests/security/test-utils";

import stopMemberTimer from "./admin/stop";
import confirmTimer from "./confirm";
import discardTimer from "./discard";
import listTimers from "./list";
import pauseTimer from "./pause";
import resumeTimer from "./resume";
import startTimer from "./start";
import updateTimer from "./update";

setDefaultTimeout(120_000);
const ids = createTestIds();
let db: TestDatabase;
const auditEvents: unknown[] = [];
const START = "2026-09-01T23:59:00.000Z";

beforeAll(async () => {
  db = await getTestDb();
  await setupRlsTestData(db, ids);

  await db
    .update(authUser)
    .set({ emailVerified: true })
    .where(inArray(authUser.id, [ids.userA1, ids.userAdmin]));
  await db
    .insert(featureEnrolments)
    .values([
      {
        organizationId: ids.orgA,
        userId: ids.userA1,
        featureId: "time-billing",
      },
      {
        organizationId: ids.orgA,
        userId: ids.userAdmin,
        featureId: "time-billing",
      },
    ])
    .onConflictDoNothing();
});
afterAll(async () => {
  await releaseTestDb();
});
afterEach(() => setSystemTime());
beforeEach(async () => {
  setSystemTime(new Date(START));
  auditEvents.length = 0;
  await db.delete(timeTimers).where(eq(timeTimers.organizationId, ids.orgA));
  await db
    .update(rateTables)
    .set({ isDefault: false })
    .where(eq(rateTables.id, ids.rateTableA1));
  await db
    .update(organizationSettings)
    .set({
      timeMinimumUnitMinutes: 15,
      timeEditWindowDays: 0,
      timeLockedThroughMonth: null,
      timeNarrativeRequired: true,
    })
    .where(eq(organizationSettings.organizationId, ids.orgA));
});

const context = (workspaceIds = [ids.wsA1]) => ({
  safeDb: asTestRaw<SafeDb>(
    createSafeDb(db, workspaceIds, ids.orgA, ids.userA1),
  ),
  scopedDb: asTestRaw<ScopedDb>(
    createScopedDb(db, workspaceIds, ids.orgA, ids.userA1),
  ),
  session: { activeOrganizationId: ids.orgA },
  user: { id: ids.userA1 },
  workspaceId: ids.wsA1,
  memberRole: sessionMemberRole("member"),
  getWorkspaceAccess: async () => ({ id: ids.wsA1, status: "active" as const }),
  pinServerValidatedWorkspaceId: () => true,
  recordAuditEvent: async (_tx: unknown, event: unknown) => {
    auditEvents.push(event);
  },
  createAuditRecorder: () => async (_tx: unknown, event: unknown) => {
    auditEvents.push(event);
  },
});

const checkedBody = <T>(schema: TSchema, body: T) => {
  expect(Value.Check(schema, body)).toBe(true);
  return body;
};

const start = async (matterId = ids.wsA1) => {
  const result = await startTimer.handler(
    createTestHandlerContext<Parameters<typeof startTimer.handler>[0]>({
      ...context(),
      body: checkedBody(startTimer.config.body, {
        matterId,
        description: "Research and drafting",
      }),
    }),
  );
  if ("code" in result) {
    throw new Error(`Timer start failed: ${JSON.stringify(result)}`);
  }
  return result;
};
const readTimer = async (id: typeof timeTimers.$inferSelect.id) =>
  await db.query.timeTimers.findFirst({ where: { id: { eq: id } } });
const confirm = async (
  id: typeof timeTimers.$inferSelect.id,
  timezoneId = "UTC",
) =>
  await confirmTimer.handler(
    createTestHandlerContext<Parameters<typeof confirmTimer.handler>[0]>({
      ...context(),
      params: { id },
      body: checkedBody(confirmTimer.config.body, { timezoneId }),
    }),
  );

describe("global timer lifecycle", () => {
  test("start and resume transfer the running state without counting paused time", async () => {
    const first = await start();
    setSystemTime(new Date("2026-09-02T00:01:00.000Z"));
    const second = await start();
    expect(await readTimer(first.id)).toMatchObject({
      state: "paused",
      accumulatedSeconds: 120,
      lastResumedAt: null,
    });
    expect(await readTimer(second.id)).toMatchObject({
      state: "running",
      accumulatedSeconds: 0,
    });
    setSystemTime(new Date("2026-09-02T00:02:00.000Z"));
    await resumeTimer.handler(
      createTestHandlerContext<Parameters<typeof resumeTimer.handler>[0]>({
        ...context(),
        params: { id: first.id },
      }),
    );
    expect(await readTimer(second.id)).toMatchObject({
      state: "paused",
      accumulatedSeconds: 60,
    });
    expect(await readTimer(first.id)).toMatchObject({
      state: "running",
      accumulatedSeconds: 120,
    });
    setSystemTime(new Date("2026-09-02T00:02:30.000Z"));
    await resumeTimer.handler(
      createTestHandlerContext<Parameters<typeof resumeTimer.handler>[0]>({
        ...context(),
        params: { id: first.id },
      }),
    );
    setSystemTime(new Date("2026-09-02T00:03:00.000Z"));
    await pauseTimer.handler(
      createTestHandlerContext<Parameters<typeof pauseTimer.handler>[0]>({
        ...context(),
        params: { id: first.id },
      }),
    );
    expect(await readTimer(first.id)).toMatchObject({
      state: "paused",
      accumulatedSeconds: 180,
    });
    setSystemTime(new Date("2026-09-02T00:04:00.000Z"));
    await pauseTimer.handler(
      createTestHandlerContext<Parameters<typeof pauseTimer.handler>[0]>({
        ...context(),
        params: { id: first.id },
      }),
    );
    expect(await readTimer(first.id)).toMatchObject({
      state: "paused",
      accumulatedSeconds: 180,
    });
    const running = await db
      .select()
      .from(timeTimers)
      .where(
        and(
          eq(timeTimers.organizationId, ids.orgA),
          eq(timeTimers.userId, ids.userA1),
          eq(timeTimers.state, "running"),
        ),
      );
    expect(running).toHaveLength(0);
  });

  test("confirm rounds by policy, survives the edit window, and converges on one draft entry", async () => {
    const timer = await start();
    setSystemTime(new Date("2026-09-02T00:01:00.000Z"));
    const first = await confirm(timer.id);
    if ("code" in first) {
      throw new Error(`Timer confirm failed: ${JSON.stringify(first)}`);
    }
    expect(await readTimer(timer.id)).toBeUndefined();
    const entry = await db.query.timeEntries.findFirst({
      where: { id: { eq: first.id } },
    });
    expect(entry).toMatchObject({
      status: BILLING_STATUS.DRAFT,
      dateWorked: "2026-09-01",
      durationMinutes: 2,
      billedMinutes: 15,
      narrative: "Research and drafting",
      billable: false,
      rateAtEntry: 0,
      currency: "XXX",
    });
    const auditCount = auditEvents.length;
    expect(auditCount).toBeGreaterThan(0);
    for (let retry = 0; retry < 3; retry += 1) {
      expect(await confirm(timer.id)).toEqual(first);
    }
    expect(auditEvents).toHaveLength(auditCount);
    const entries = await db
      .select()
      .from(timeEntries)
      .where(eq(timeEntries.id, first.id));
    expect(entries).toHaveLength(1);
  });

  test("replaying confirmation after entry deletion refuses to recreate it", async () => {
    const timer = await start();
    const completed = await confirm(timer.id);
    if ("code" in completed) {
      throw new Error(`Timer confirm failed: ${JSON.stringify(completed)}`);
    }
    await db.delete(timeEntries).where(eq(timeEntries.id, completed.id));
    const before = await db
      .select()
      .from(timeEntries)
      .where(
        and(
          eq(timeEntries.organizationId, ids.orgA),
          eq(timeEntries.userId, ids.userA1),
        ),
      );
    const auditCount = auditEvents.length;
    expect(await confirm(timer.id)).toMatchObject({
      code: 409,
      response: { message: "The confirmed entry was deleted" },
    });
    expect(await confirm(timer.id)).toMatchObject({ code: 409 });
    expect(
      await db
        .select()
        .from(timeEntries)
        .where(
          and(
            eq(timeEntries.organizationId, ids.orgA),
            eq(timeEntries.userId, ids.userA1),
          ),
        ),
    ).toEqual(before);
    expect(auditEvents).toHaveLength(auditCount);
    expect(await readTimer(timer.id)).toBeUndefined();
  });

  test.each([
    ["owner", true, "Client-facing research"],
    ["admin", true, "Client-facing research"],
    ["owner", false, null],
    ["admin", false, null],
    ["owner", true, ""],
    ["admin", true, ""],
  ] as const)(
    "%s migrated completion preserves billing fields (noCharge=%p, invoiceNarrative=%p)",
    async (completion, noCharge, invoiceNarrative) => {
      const complete = async (timerId: typeof timeTimers.$inferSelect.id) => {
        if (completion === "owner") {
          return await confirm(timerId, "UTC");
        }
        return await stopMemberTimer.handler(
          createTestHandlerContext<
            Parameters<typeof stopMemberTimer.handler>[0]
          >({
            ...context(),
            safeDb: asTestRaw<SafeDb>(
              createSafeDb(db, [ids.wsA1], ids.orgA, ids.userAdmin),
            ),
            memberRole: sessionMemberRole("admin"),
            user: { id: ids.userAdmin },
            params: { id: timerId },
            body: checkedBody(stopMemberTimer.config.body, {}),
          }),
        );
      };
      const deletedTableId = createSafeId<"rateTable">();
      await db.insert(rateTables).values({
        id: deletedTableId,
        organizationId: ids.orgA,
        workspaceId: ids.wsA1,
        name: "Temporary rate",
        currency: "CHF",
        isDefault: true,
      });
      const legacyId = createSafeId<"timeEntry">();
      await db.insert(timeEntries).values({
        id: legacyId,
        organizationId: ids.orgA,
        workspaceId: ids.wsA1,
        userId: ids.userA1,
        dateWorked: "2026-08-20",
        timezoneId: "Asia/Tokyo",
        durationMinutes: 0,
        timerStartedAt: new Date(START),
        billedMinutes: 0,
        rateAtEntry: cents(12_345),
        currency: "CHF",
        narrative: "Legacy research",
        billable: true,
        noCharge,
        invoiceNarrative,
        source: TIME_ENTRY_SOURCE.TIMER,
        status: BILLING_STATUS.DRAFT,
      });
      const timerId = createSafeId<"timeTimer">();
      await db.insert(timeTimers).values({
        id: timerId,
        organizationId: ids.orgA,
        workspaceId: ids.wsA1,
        userId: ids.userA1,
        legacyTimeEntryId: legacyId,
        description: "Legacy research",
        state: completion === "admin" ? "running" : "paused",
        startedAt: new Date(START),
        accumulatedSeconds: 120,
        lastResumedAt: completion === "admin" ? new Date(START) : null,
      });
      await db.delete(rateTables).where(eq(rateTables.id, deletedTableId));
      expect(
        await db.query.rateTables.findFirst({
          where: { workspaceId: { eq: ids.wsA1 }, isDefault: true },
        }),
      ).toBeUndefined();
      await db
        .update(organizationSettings)
        .set({ timeLockedThroughMonth: "2026-08-31" })
        .where(eq(organizationSettings.organizationId, ids.orgA));
      const beforeRefusal = await db
        .select()
        .from(timeEntries)
        .where(
          and(
            eq(timeEntries.organizationId, ids.orgA),
            eq(timeEntries.userId, ids.userA1),
          ),
        );
      expect(await complete(timerId)).toMatchObject({ code: 400 });
      expect(await readTimer(timerId)).toBeDefined();
      expect(
        await db.query.timeEntries.findFirst({
          where: { id: { eq: legacyId } },
        }),
      ).toBeDefined();
      expect(
        await db
          .select()
          .from(timeEntries)
          .where(
            and(
              eq(timeEntries.organizationId, ids.orgA),
              eq(timeEntries.userId, ids.userA1),
            ),
          ),
      ).toEqual(beforeRefusal);
      await db
        .update(organizationSettings)
        .set({ timeLockedThroughMonth: null })
        .where(eq(organizationSettings.organizationId, ids.orgA));
      const completed = await complete(timerId);
      if ("code" in completed) {
        throw new Error(`Timer confirm failed: ${JSON.stringify(completed)}`);
      }
      expect(completed.id).not.toBe(legacyId);
      expect(
        await db.query.timeEntries.findFirst({
          where: { id: { eq: legacyId } },
        }),
      ).toBeUndefined();
      expect(await readTimer(timerId)).toBeUndefined();
      expect(
        await db.query.timeEntries.findFirst({
          where: { id: { eq: completed.id } },
        }),
      ).toMatchObject({
        dateWorked: "2026-08-20",
        timezoneId: "Asia/Tokyo",
        rateAtEntry: 12_345,
        currency: "CHF",
        billable: true,
        noCharge,
        invoiceNarrative,
        status: BILLING_STATUS.DRAFT,
        narrative: "Legacy research",
        durationMinutes: 2,
        billedMinutes: 15,
      });
      expect(await complete(timerId)).toEqual(completed);
      expect(await confirm(timerId, "Europe/Madrid")).toEqual(completed);
      expect(
        await db.query.timeEntries.findFirst({
          where: { id: { eq: completed.id } },
        }),
      ).toMatchObject({ noCharge, invoiceNarrative });
    },
  );

  test("completion snapshots the effective billing rate when one exists", async () => {
    await db
      .update(rateTables)
      .set({ isDefault: true })
      .where(eq(rateTables.id, ids.rateTableA1));
    const timer = await start();
    setSystemTime(new Date("2026-09-02T00:01:00.000Z"));
    const result = await confirm(timer.id);
    if ("code" in result) {
      throw new Error(`Timer confirm failed: ${JSON.stringify(result)}`);
    }
    const entry = await db.query.timeEntries.findFirst({
      where: { id: { eq: result.id } },
    });
    expect(entry).toMatchObject({
      billable: true,
      rateAtEntry: 200,
      currency: "USD",
      billedMinutes: 15,
    });
  });

  test("explicit internal confirmation preserves actual time, zero billing, and replay identity", async () => {
    const started = await startTimer.handler(
      createTestHandlerContext<Parameters<typeof startTimer.handler>[0]>({
        ...context(),
        body: checkedBody(startTimer.config.body, {
          description: "Internal training",
        }),
      }),
    );
    if ("code" in started) {
      throw new Error(`Timer start failed: ${JSON.stringify(started)}`);
    }
    setSystemTime(new Date("2026-09-02T00:06:00.000Z"));
    const request = createTestHandlerContext<
      Parameters<typeof confirmTimer.handler>[0]
    >({
      ...context([]),
      params: { id: started.id },
      body: checkedBody(confirmTimer.config.body, {
        timezoneId: "UTC",
        activityGroup: TIME_ENTRY_ACTIVITY_GROUP.INTERNAL,
      }),
    });
    const completed = await confirmTimer.handler(request);
    if ("code" in completed) {
      throw new Error(`Internal confirm failed: ${JSON.stringify(completed)}`);
    }
    expect(completed).toMatchObject({
      activityGroup: TIME_ENTRY_ACTIVITY_GROUP.INTERNAL,
      durationMinutes: 7,
      billedMinutes: 0,
    });
    expect(
      await db.query.timeEntries.findFirst({
        where: { id: { eq: completed.id } },
      }),
    ).toMatchObject({
      activityGroup: TIME_ENTRY_ACTIVITY_GROUP.INTERNAL,
      workspaceId: null,
      workItemId: null,
      billable: false,
      noCharge: false,
      durationMinutes: 7,
      billedMinutes: 0,
      rateAtEntry: 0,
      currency: "XXX",
      invoiceId: null,
      invoiceNarrative: null,
      taskCode: null,
      activityCode: null,
      status: BILLING_STATUS.DRAFT,
      source: TIME_ENTRY_SOURCE.TIMER,
    });
    expect(await readTimer(started.id)).toBeUndefined();
    expect(await confirmTimer.handler(request)).toEqual(completed);
  });

  test("internal confirmation refuses an assigned matter or billable request without consuming the timer", async () => {
    const assigned = await start();
    expect(
      await confirmTimer.handler(
        createTestHandlerContext<Parameters<typeof confirmTimer.handler>[0]>({
          ...context(),
          params: { id: assigned.id },
          body: checkedBody(confirmTimer.config.body, {
            timezoneId: "UTC",
            activityGroup: TIME_ENTRY_ACTIVITY_GROUP.INTERNAL,
          }),
        }),
      ),
    ).toMatchObject({ code: 400 });
    expect(await readTimer(assigned.id)).toBeDefined();
    await updateTimer.handler(
      createTestHandlerContext<Parameters<typeof updateTimer.handler>[0]>({
        ...context(),
        params: { id: assigned.id },
        body: checkedBody(updateTimer.config.body, { matterId: null }),
      }),
    );
    expect(
      await confirmTimer.handler(
        createTestHandlerContext<Parameters<typeof confirmTimer.handler>[0]>({
          ...context([]),
          params: { id: assigned.id },
          body: checkedBody(confirmTimer.config.body, {
            timezoneId: "UTC",
            activityGroup: TIME_ENTRY_ACTIVITY_GROUP.INTERNAL,
            billable: true,
          }),
        }),
      ),
    ).toMatchObject({ code: 400 });
    expect(await readTimer(assigned.id)).toBeDefined();
  });

  test("a locked month refuses internal timer confirmation and retains its timer", async () => {
    const started = await startTimer.handler(
      createTestHandlerContext<Parameters<typeof startTimer.handler>[0]>({
        ...context(),
        body: checkedBody(startTimer.config.body, {
          description: "Internal work",
        }),
      }),
    );
    if ("code" in started) {
      throw new Error(`Timer start failed: ${JSON.stringify(started)}`);
    }
    await db
      .update(organizationSettings)
      .set({ timeLockedThroughMonth: "2026-09-30" })
      .where(eq(organizationSettings.organizationId, ids.orgA));
    expect(
      await confirmTimer.handler(
        createTestHandlerContext<Parameters<typeof confirmTimer.handler>[0]>({
          ...context([]),
          params: { id: started.id },
          body: checkedBody(confirmTimer.config.body, {
            timezoneId: "UTC",
            activityGroup: TIME_ENTRY_ACTIVITY_GROUP.INTERNAL,
          }),
        }),
      ),
    ).toMatchObject({ code: 400 });
    expect(await readTimer(started.id)).toBeDefined();
  });

  test("confirm requires a matter and retains the timer on refusal", async () => {
    const started = await startTimer.handler(
      createTestHandlerContext<Parameters<typeof startTimer.handler>[0]>({
        ...context(),
        body: checkedBody(startTimer.config.body, { description: "Research" }),
      }),
    );
    if ("code" in started) {
      throw new Error(`Timer start failed: ${JSON.stringify(started)}`);
    }
    const auditCount = auditEvents.length;
    const result = await confirm(started.id);
    expect(result).toMatchObject({ code: 400 });
    expect(await readTimer(started.id)).toBeDefined();
    expect(auditEvents).toHaveLength(auditCount);
    const listed = await listTimers.handler(
      createTestHandlerContext<Parameters<typeof listTimers.handler>[0]>({
        ...context(),
        query: {},
      }),
    );
    expect(listed).toMatchObject({
      items: [{ id: started.id, matterId: null, description: "Research" }],
    });
    await updateTimer.handler(
      createTestHandlerContext<Parameters<typeof updateTimer.handler>[0]>({
        ...context(),
        params: { id: started.id },
        body: checkedBody(updateTimer.config.body, { matterId: ids.wsA1 }),
      }),
    );
    const completed = await confirm(started.id);
    expect(completed).toHaveProperty("id");
    expect(await readTimer(started.id)).toBeUndefined();
  });

  test("a migrated draft completed in another matter starts its billing fields over", async () => {
    const originalMatterId = createSafeId<"workspace">();
    await db.insert(workspaces).values({
      id: originalMatterId,
      organizationId: ids.orgA,
      name: "Original timer matter",
      reference: originalMatterId,
      status: "active",
    });
    await db.insert(workspaceMembers).values({
      id: createSafeId<"workspaceMember">(),
      workspaceId: originalMatterId,
      userId: ids.userA1,
    });
    const legacyId = createSafeId<"timeEntry">();
    await db.insert(timeEntries).values({
      id: legacyId,
      organizationId: ids.orgA,
      workspaceId: originalMatterId,
      userId: ids.userA1,
      dateWorked: "2026-09-01",
      timezoneId: "UTC",
      durationMinutes: 0,
      timerStartedAt: new Date(START),
      billedMinutes: 0,
      rateAtEntry: cents(12_345),
      currency: "CHF",
      narrative: "Legacy research",
      // Not billable, so completion in a matter without a rate table succeeds.
      billable: false,
      noCharge: true,
      invoiceNarrative: "Wording for the original client",
      source: TIME_ENTRY_SOURCE.TIMER,
      status: BILLING_STATUS.DRAFT,
    });
    const timerId = createSafeId<"timeTimer">();
    await db.insert(timeTimers).values({
      id: timerId,
      organizationId: ids.orgA,
      workspaceId: originalMatterId,
      userId: ids.userA1,
      legacyTimeEntryId: legacyId,
      description: "Legacy research",
      state: "paused",
      startedAt: new Date(START),
      accumulatedSeconds: 120,
      lastResumedAt: null,
    });
    const completeInOtherMatter = async () => {
      const bothMatters = context([originalMatterId, ids.wsA1]);
      const reassigned = await updateTimer.handler(
        createTestHandlerContext<Parameters<typeof updateTimer.handler>[0]>({
          ...bothMatters,
          params: { id: timerId },
          body: checkedBody(updateTimer.config.body, { matterId: ids.wsA1 }),
        }),
      );
      expect(reassigned).toMatchObject({ id: timerId, matterId: ids.wsA1 });
      const completed = await confirmTimer.handler(
        createTestHandlerContext<Parameters<typeof confirmTimer.handler>[0]>({
          ...bothMatters,
          params: { id: timerId },
          body: checkedBody(confirmTimer.config.body, { timezoneId: "UTC" }),
        }),
      );
      if ("code" in completed) {
        throw new Error(`Timer confirm failed: ${JSON.stringify(completed)}`);
      }
      expect(
        await db.query.timeEntries.findFirst({
          where: { id: { eq: completed.id } },
        }),
      ).toMatchObject({
        workspaceId: ids.wsA1,
        noCharge: false,
        invoiceNarrative: null,
      });
      await db.delete(timeEntries).where(eq(timeEntries.id, completed.id));
    };
    try {
      await completeInOtherMatter();
    } finally {
      await db.delete(timeTimers).where(eq(timeTimers.id, timerId));
      await db.delete(timeEntries).where(eq(timeEntries.id, legacyId));
      await db.delete(workspaces).where(eq(workspaces.id, originalMatterId));
    }
  });

  test("a timer survives matter membership removal and confirms after reassignment", async () => {
    const originalMatterId = createSafeId<"workspace">();
    await db.insert(workspaces).values({
      id: originalMatterId,
      organizationId: ids.orgA,
      name: "Timer matter",
      reference: originalMatterId,
      status: "active",
    });
    const membershipId = createSafeId<"workspaceMember">();
    await db.insert(workspaceMembers).values({
      id: membershipId,
      workspaceId: originalMatterId,
      userId: ids.userA1,
    });
    const originalContext = context([originalMatterId, ids.wsA1]);
    const started = await startTimer.handler(
      createTestHandlerContext<Parameters<typeof startTimer.handler>[0]>({
        ...originalContext,
        body: checkedBody(startTimer.config.body, {
          matterId: originalMatterId,
          description: "Research after reassignment",
        }),
      }),
    );
    if ("code" in started) {
      throw new Error(`Timer start failed: ${JSON.stringify(started)}`);
    }
    const originalTimer = await readTimer(started.id);
    expect(originalTimer).toMatchObject({
      workspaceId: originalMatterId,
      legacyTimeEntryId: null,
      state: "running",
    });
    const removed = await db
      .delete(workspaceMembers)
      .where(eq(workspaceMembers.id, membershipId))
      .returning({ id: workspaceMembers.id });
    expect(removed).toEqual([{ id: membershipId }]);
    const beforeEntries = await db
      .select({ id: timeEntries.id })
      .from(timeEntries)
      .where(eq(timeEntries.organizationId, ids.orgA));
    const auditCount = auditEvents.length;
    setSystemTime(new Date("2026-09-02T00:01:00.000Z"));
    const refused = await confirmTimer.handler(
      createTestHandlerContext<Parameters<typeof confirmTimer.handler>[0]>({
        ...originalContext,
        params: { id: started.id },
        body: checkedBody(confirmTimer.config.body, { timezoneId: "UTC" }),
      }),
    );
    expect(refused).toMatchObject({
      code: 404,
      response: { message: "Matter not found or not accessible" },
    });
    expect(await readTimer(started.id)).toEqual(originalTimer);
    expect(
      await db
        .select({ id: timeEntries.id })
        .from(timeEntries)
        .where(eq(timeEntries.organizationId, ids.orgA)),
    ).toEqual(beforeEntries);
    expect(auditEvents).toHaveLength(auditCount);
    const reassigned = await updateTimer.handler(
      createTestHandlerContext<Parameters<typeof updateTimer.handler>[0]>({
        ...context(),
        params: { id: started.id },
        body: checkedBody(updateTimer.config.body, { matterId: ids.wsA1 }),
      }),
    );
    expect(reassigned).toMatchObject({ id: started.id, matterId: ids.wsA1 });
    const completed = await confirm(started.id);
    if ("code" in completed) {
      throw new Error(`Timer confirm failed: ${JSON.stringify(completed)}`);
    }
    expect(await readTimer(started.id)).toBeUndefined();
    expect(
      await db.query.timeEntries.findFirst({
        where: { id: { eq: completed.id } },
      }),
    ).toMatchObject({
      workspaceId: ids.wsA1,
      source: TIME_ENTRY_SOURCE.TIMER,
      status: BILLING_STATUS.DRAFT,
      durationMinutes: 2,
    });
    await db.delete(workspaces).where(eq(workspaces.id, originalMatterId));
  });

  test("confirm rejects invalid timezone before creating an entry", async () => {
    const timer = await start();
    expect(await confirm(timer.id, "Not/A_Real_Zone")).toMatchObject({
      code: 400,
    });
    expect(await readTimer(timer.id)).toBeDefined();
  });

  test("narrative and monthly lock policy remain mandatory at completion", async () => {
    const timer = await start();
    await updateTimer.handler(
      createTestHandlerContext<Parameters<typeof updateTimer.handler>[0]>({
        ...context(),
        params: { id: timer.id },
        body: checkedBody(updateTimer.config.body, { description: " " }),
      }),
    );
    expect(await confirm(timer.id)).toMatchObject({ code: 400 });
    expect(await readTimer(timer.id)).toBeDefined();
    await updateTimer.handler(
      createTestHandlerContext<Parameters<typeof updateTimer.handler>[0]>({
        ...context(),
        params: { id: timer.id },
        body: checkedBody(updateTimer.config.body, {
          description: "Restored narrative",
        }),
      }),
    );
    await db
      .update(organizationSettings)
      .set({ timeLockedThroughMonth: "2026-09-30" })
      .where(eq(organizationSettings.organizationId, ids.orgA));
    expect(await confirm(timer.id)).toMatchObject({ code: 400 });
    expect(await readTimer(timer.id)).toBeDefined();
  });

  test("confirmation and discard retain migrated timers when their original entry is outside the current matter scope", async () => {
    const legacyId = createSafeId<"timeEntry">();
    await db.insert(timeEntries).values({
      id: legacyId,
      organizationId: ids.orgA,
      workspaceId: ids.wsA2,
      userId: ids.userA1,
      dateWorked: "2026-09-01",
      timezoneId: "UTC",
      durationMinutes: 0,
      timerStartedAt: new Date(START),
      billedMinutes: 0,
      rateAtEntry: cents(0),
      currency: "XXX",
      narrative: "Original research",
      billable: false,
      source: TIME_ENTRY_SOURCE.TIMER,
      status: BILLING_STATUS.DRAFT,
    });
    const timerId = createSafeId<"timeTimer">();
    await db.insert(timeTimers).values({
      id: timerId,
      organizationId: ids.orgA,
      workspaceId: ids.wsA1,
      userId: ids.userA1,
      legacyTimeEntryId: legacyId,
      description: "Research",
      state: "paused",
      startedAt: new Date(START),
      accumulatedSeconds: 120,
      lastResumedAt: null,
    });
    const original = await db.query.timeEntries.findFirst({
      where: { id: { eq: legacyId } },
    });
    expect(original).toBeDefined();
    const scopedOriginal = await context().safeDb((tx) =>
      tx.query.timeEntries.findFirst({ where: { id: { eq: legacyId } } }),
    );
    expect(scopedOriginal.isOk()).toBe(true);
    if (scopedOriginal.isErr()) {
      throw new Error(
        `Scoped entry lookup failed: ${JSON.stringify(scopedOriginal.error)}`,
      );
    }
    expect(scopedOriginal.value).toBeUndefined();
    expect(await confirm(timerId)).toMatchObject({
      code: 404,
      response: { message: "Original timer entry is not accessible" },
    });
    expect(await readTimer(timerId)).toMatchObject({
      legacyTimeEntryId: legacyId,
    });
    expect(
      await db.query.timeEntries.findFirst({ where: { id: { eq: legacyId } } }),
    ).toEqual(original);
    const discarded = await discardTimer.handler(
      createTestHandlerContext<Parameters<typeof discardTimer.handler>[0]>({
        ...context(),
        params: { id: timerId },
      }),
    );
    expect(discarded).toMatchObject({
      code: 404,
      response: { message: "Original timer entry is not accessible" },
    });
    expect(await readTimer(timerId)).toMatchObject({
      legacyTimeEntryId: legacyId,
    });
    expect(
      await db.query.timeEntries.findFirst({ where: { id: { eq: legacyId } } }),
    ).toEqual(original);
    expect(auditEvents).toHaveLength(0);
  });

  test("discard retains a migrated entry that was changed to manual time", async () => {
    const legacyId = createSafeId<"timeEntry">();
    await db.insert(timeEntries).values({
      id: legacyId,
      organizationId: ids.orgA,
      workspaceId: ids.wsA1,
      userId: ids.userA1,
      dateWorked: "2026-09-01",
      timezoneId: "UTC",
      durationMinutes: 12,
      billedMinutes: 15,
      rateAtEntry: cents(0),
      currency: "XXX",
      narrative: "Original research",
      billable: false,
      source: TIME_ENTRY_SOURCE.TIMER,
      status: BILLING_STATUS.DRAFT,
    });
    const timerId = createSafeId<"timeTimer">();
    await db.insert(timeTimers).values({
      id: timerId,
      organizationId: ids.orgA,
      workspaceId: ids.wsA1,
      userId: ids.userA1,
      legacyTimeEntryId: legacyId,
      description: "Research",
      state: "paused",
      startedAt: new Date(START),
      accumulatedSeconds: 120,
      lastResumedAt: null,
    });
    await db
      .update(timeEntries)
      .set({ source: TIME_ENTRY_SOURCE.MANUAL })
      .where(eq(timeEntries.id, legacyId));
    const original = await db.query.timeEntries.findFirst({
      where: { id: { eq: legacyId } },
    });
    expect(original).toMatchObject({ source: TIME_ENTRY_SOURCE.MANUAL });
    const discarded = await discardTimer.handler(
      createTestHandlerContext<Parameters<typeof discardTimer.handler>[0]>({
        ...context(),
        params: { id: timerId },
      }),
    );
    expect(discarded).toEqual({ id: timerId });
    expect(await readTimer(timerId)).toBeUndefined();
    expect(
      await db.query.timeEntries.findFirst({ where: { id: { eq: legacyId } } }),
    ).toEqual(original);
    expect(auditEvents).toEqual([
      expect.objectContaining({
        action: AUDIT_ACTION.DELETE,
        resourceType: AUDIT_RESOURCE_TYPE.TIME_TIMER,
        resourceId: timerId,
      }),
    ]);
  });

  test("discard removes the timer and records the action", async () => {
    const timer = await start();
    const before = auditEvents.length;
    await discardTimer.handler(
      createTestHandlerContext<Parameters<typeof discardTimer.handler>[0]>({
        ...context(),
        params: { id: timer.id },
      }),
    );
    expect(await readTimer(timer.id)).toBeUndefined();
    expect(auditEvents.length).toBe(before + 1);
    expect(auditEvents.at(-1)).toMatchObject({
      action: AUDIT_ACTION.DELETE,
      resourceId: timer.id,
    });
  });
});
