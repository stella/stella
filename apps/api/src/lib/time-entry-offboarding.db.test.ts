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
import { and, eq } from "drizzle-orm";

import {
  TIME_ENTRY_ACTIVITY_GROUP,
  type TimeEntryActivityGroup,
} from "@stll/api-contract";

import { member } from "@/api/db/auth-schema";
import {
  organizationSettings,
  timeEntries,
  timeTimers,
  timeEntryTimerStates,
  workspaceMembers,
  workspaces,
} from "@/api/db/schema";
import { createSafeDb, createScopedDb } from "@/api/db/scoped";
import deleteTimeEntry from "@/api/handlers/time-entries/delete";
import updateTimeEntry from "@/api/handlers/time-entries/update";
import { getAuth } from "@/api/lib/auth";
import { UNPRICED_TIME_ENTRY_CURRENCY } from "@/api/lib/billing-constants";
import { createSafeId } from "@/api/lib/branded-types";
import { cents } from "@/api/lib/money";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import {
  brandPersistedOrganizationId,
  brandPersistedUserId,
} from "@/api/lib/safe-id-boundaries";
import { signInHuman } from "@/api/tests/helpers/human-session";
import {
  initAgentAuthTestDb,
  releaseAgentAuthTestDb,
} from "@/api/tests/helpers/mock-agent-auth-db";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { enrolledTimeBillingSnapshot } from "@/api/tests/helpers/time-billing-enrolment";
import type { TestDatabase } from "@/api/tests/security/test-utils";

setDefaultTimeout(120_000);

let testDb: TestDatabase;

beforeAll(async () => {
  testDb = await initAgentAuthTestDb();
});

afterAll(async () => {
  await releaseAgentAuthTestDb();
});

beforeEach(() => setSystemTime(new Date("2026-09-30T12:00:00Z")));
afterEach(() => setSystemTime());

const createMemberWithActiveTimer = async (
  dateWorked: string,
  activityGroup: TimeEntryActivityGroup = TIME_ENTRY_ACTIVITY_GROUP.CLIENT,
) => {
  const auth = getAuth();
  const owner = await signInHuman(
    `timer-owner-${Bun.randomUUIDv7()}@stella.dev`,
  );
  const organization = await auth.api.createOrganization({
    body: {
      name: "Timer offboarding",
      slug: `timer-offboarding-${Bun.randomUUIDv7()}`,
    },
    headers: owner.headers(),
  });
  await owner.setActiveOrganization(organization.id);

  const invitee = await signInHuman(
    `timer-member-${Bun.randomUUIDv7()}@stella.dev`,
  );
  const invitation = await auth.api.createInvitation({
    body: {
      email: invitee.email,
      role: "member",
      organizationId: organization.id,
    },
    headers: owner.headers(),
  });
  await auth.api.acceptInvitation({
    body: { invitationId: invitation.id },
    headers: invitee.headers(),
  });

  const organizationId = brandPersistedOrganizationId(organization.id);
  const userId = brandPersistedUserId(invitee.userId);
  const workspaceId = createSafeId<"workspace">();
  const timerId = createSafeId<"timeEntry">();
  await testDb.insert(workspaces).values({
    id: workspaceId,
    organizationId,
    name: "Timer matter",
    reference: `T-${workspaceId.slice(-8)}`,
  });
  await testDb.insert(timeEntries).values({
    id: timerId,
    organizationId,
    workspaceId:
      activityGroup === TIME_ENTRY_ACTIVITY_GROUP.CLIENT ? workspaceId : null,
    activityGroup,
    userId,
    dateWorked,
    timezoneId: "UTC",
    durationMinutes: 0,
    billedMinutes: 0,
    rateAtEntry: cents(
      activityGroup === TIME_ENTRY_ACTIVITY_GROUP.CLIENT ? 100 : 0,
    ),
    billable: activityGroup === TIME_ENTRY_ACTIVITY_GROUP.CLIENT,
    currency:
      activityGroup === TIME_ENTRY_ACTIVITY_GROUP.CLIENT
        ? "USD"
        : UNPRICED_TIME_ENTRY_CURRENCY,
    narrative: "",
    source: "timer",
    timerStartedAt: new Date(Date.now() - 3_600_000),
  });
  const ownerId = brandPersistedUserId(owner.userId);
  await testDb.insert(workspaceMembers).values([
    { id: createSafeId<"workspaceMember">(), workspaceId, userId: ownerId },
    { id: createSafeId<"workspaceMember">(), workspaceId, userId },
  ]);
  const globalTimerId = createSafeId<"timeTimer">();
  await testDb.insert(timeTimers).values({
    id: globalTimerId,
    organizationId,
    userId,
    workspaceId:
      activityGroup === TIME_ENTRY_ACTIVITY_GROUP.CLIENT ? workspaceId : null,
    legacyTimeEntryId: timerId,
    state: "running",
    startedAt: new Date(Date.now() - 86_400_000),
    lastResumedAt: new Date(Date.now() - 120_000),
    accumulatedSeconds: 601,
    description: "Research",
  });
  return {
    auth,
    invitee,
    organization,
    organizationId,
    owner,
    ownerId,
    workspaceId,
    timerId,
    globalTimerId,
    userId,
  };
};

describe("member removal with an active timer", () => {
  test("rejects removal when the timer's date is locked, preserving both rows", async () => {
    const fixture = await createMemberWithActiveTimer("2025-01-31");
    await testDb.insert(organizationSettings).values({
      id: createSafeId<"organizationSettings">(),
      organizationId: fixture.organizationId,
      timeLockedThroughMonth: "2025-01-31",
    });

    const entryBefore = await testDb.query.timeEntries.findFirst({
      where: { id: { eq: fixture.timerId } },
    });
    const timerBefore = await testDb.query.timeTimers.findFirst({
      where: { id: { eq: fixture.globalTimerId } },
    });
    const response = await fixture.auth.api.removeMember({
      body: {
        memberIdOrEmail: fixture.invitee.email,
        organizationId: fixture.organization.id,
      },
      headers: fixture.owner.headers(),
      asResponse: true,
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: "time_period_locked",
    });

    const [remainingMember] = await testDb
      .select({ id: member.id })
      .from(member)
      .where(
        and(
          eq(member.organizationId, fixture.organization.id),
          eq(member.userId, fixture.userId),
        ),
      );
    const [activeTimer] = await testDb
      .select({ timerStartedAt: timeEntries.timerStartedAt })
      .from(timeEntries)
      .where(eq(timeEntries.id, fixture.timerId));
    expect(remainingMember).toBeDefined();
    expect(activeTimer?.timerStartedAt).toBeInstanceOf(Date);
    const globalTimer = await testDb.query.timeTimers.findFirst({
      where: { id: { eq: fixture.globalTimerId } },
    });
    expect(globalTimer).toMatchObject({
      state: "running",
      accumulatedSeconds: 601,
    });
    expect(
      await testDb.query.timeEntries.findFirst({
        where: { id: { eq: fixture.timerId } },
      }),
    ).toEqual(entryBefore);
    expect(globalTimer).toEqual(timerBefore);
    expect(
      (
        await testDb
          .select()
          .from(timeEntryTimerStates)
          .where(eq(timeEntryTimerStates.entryId, fixture.timerId))
      ).at(0),
    ).toMatchObject({ state: "running" });
  });

  test("closes an internal timer without a matter and preserves zero billing during member removal", async () => {
    const fixture = await createMemberWithActiveTimer(
      "2026-09-30",
      TIME_ENTRY_ACTIVITY_GROUP.INTERNAL,
    );
    const before = await testDb.query.timeEntries.findFirst({
      where: { id: { eq: fixture.timerId } },
    });
    expect(before).toMatchObject({
      activityGroup: "internal",
      workspaceId: null,
      billedMinutes: 0,
    });
    const response = await fixture.auth.api.removeMember({
      body: {
        memberIdOrEmail: fixture.invitee.email,
        organizationId: fixture.organization.id,
      },
      headers: fixture.owner.headers(),
      asResponse: true,
    });
    expect(response.status, await response.clone().text()).toBe(200);
    expect(
      await testDb.query.timeEntries.findFirst({
        where: { id: { eq: fixture.timerId } },
      }),
    ).toMatchObject({
      activityGroup: "internal",
      workspaceId: null,
      durationMinutes: 12,
      billedMinutes: 0,
      rateAtEntry: 0,
      currency: UNPRICED_TIME_ENTRY_CURRENCY,
      billable: false,
      timerStartedAt: null,
      timerStoppedAt: expect.any(Date),
    });
    expect(
      await testDb.query.timeTimers.findFirst({
        where: { id: { eq: fixture.globalTimerId } },
      }),
    ).toMatchObject({ state: "paused", accumulatedSeconds: 721 });
    expect(
      await testDb
        .select({ id: member.id })
        .from(member)
        .where(
          and(
            eq(member.organizationId, fixture.organization.id),
            eq(member.userId, fixture.userId),
          ),
        ),
    ).toEqual([]);
  });

  test("closes an unlocked timer and removes the member", async () => {
    const fixture = await createMemberWithActiveTimer("2026-09-30");
    await testDb.insert(organizationSettings).values({
      id: createSafeId<"organizationSettings">(),
      organizationId: fixture.organizationId,
      timeLockedThroughMonth: "2026-08-31",
      timeMinimumUnitMinutes: 15,
    });

    const response = await fixture.auth.api.removeMember({
      body: {
        memberIdOrEmail: fixture.invitee.email,
        organizationId: fixture.organization.id,
      },
      headers: fixture.owner.headers(),
      asResponse: true,
    });
    expect(response.status, await response.clone().text()).toBe(200);

    const [remainingMember] = await testDb
      .select({ id: member.id })
      .from(member)
      .where(
        and(
          eq(member.organizationId, fixture.organization.id),
          eq(member.userId, fixture.userId),
        ),
      );
    const [stoppedTimer] = await testDb
      .select({
        durationMinutes: timeEntries.durationMinutes,
        billedMinutes: timeEntries.billedMinutes,
        timerStartedAt: timeEntries.timerStartedAt,
        timerStoppedAt: timeEntries.timerStoppedAt,
      })
      .from(timeEntries)
      .where(eq(timeEntries.id, fixture.timerId));
    expect(remainingMember).toBeUndefined();
    expect(stoppedTimer?.timerStartedAt).toBeNull();
    expect(stoppedTimer?.timerStoppedAt).toBeInstanceOf(Date);
    expect(stoppedTimer?.durationMinutes).toBe(12);
    expect(stoppedTimer?.billedMinutes).toBe(15);
    const globalTimer = await testDb.query.timeTimers.findFirst({
      where: { id: { eq: fixture.globalTimerId } },
    });
    expect(globalTimer).toMatchObject({ state: "paused", lastResumedAt: null });
    expect(globalTimer?.accumulatedSeconds).toBe(721);
    expect(
      (
        await testDb
          .select()
          .from(timeEntryTimerStates)
          .where(eq(timeEntryTimerStates.entryId, fixture.timerId))
      ).at(0),
    ).toMatchObject({ state: "paused" });
    const recordAuditEvent = async () => undefined;
    const context = {
      user: { id: fixture.ownerId },
      memberRole: sessionMemberRole("owner"),
      session: { activeOrganizationId: fixture.organizationId },
      workspaceId: fixture.workspaceId,
      safeDb: createSafeDb(
        testDb,
        [fixture.workspaceId],
        fixture.organizationId,
        fixture.ownerId,
      ),
      scopedDb: createScopedDb(
        testDb,
        [fixture.workspaceId],
        fixture.organizationId,
        fixture.ownerId,
      ),
      recordAuditEvent,
      createAuditRecorder: () => recordAuditEvent,
      request: new Request("https://example.test/time-entry-offboarding"),
      route: "/test/time-entry-offboarding",
      featureAccessSnapshot: enrolledTimeBillingSnapshot({
        userId: fixture.ownerId,
        organizationId: fixture.organizationId,
      }),
    };
    expect(
      await updateTimeEntry.handler(
        asTestRaw<Parameters<typeof updateTimeEntry.handler>[0]>({
          ...context,
          body: { id: fixture.timerId, narrative: "Reviewed recorded work" },
        }),
      ),
    ).not.toHaveProperty("code");
    expect(
      await testDb.query.timeEntries.findFirst({
        where: { id: { eq: fixture.timerId } },
      }),
    ).toMatchObject({
      userId: fixture.userId,
      narrative: "Reviewed recorded work",
      durationMinutes: 12,
      billedMinutes: 15,
      timerStartedAt: null,
    });
    expect(
      await deleteTimeEntry.handler(
        asTestRaw<Parameters<typeof deleteTimeEntry.handler>[0]>({
          ...context,
          body: { id: fixture.timerId },
        }),
      ),
    ).toMatchObject({ deleted: true });
    expect(
      await testDb.query.timeEntries.findFirst({
        where: { id: { eq: fixture.timerId } },
      }),
    ).toBeUndefined();
    expect(
      (
        await testDb
          .select()
          .from(timeEntryTimerStates)
          .where(eq(timeEntryTimerStates.entryId, fixture.timerId))
      ).at(0),
    ).toBeUndefined();
  });
});
