import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { and, eq } from "drizzle-orm";

import { member } from "@/api/db/auth-schema";
import {
  organizationSettings,
  timeEntries,
  timeTimers,
  workspaces,
} from "@/api/db/schema";
import { getAuth } from "@/api/lib/auth";
import { createSafeId } from "@/api/lib/branded-types";
import { cents } from "@/api/lib/money";
import {
  brandPersistedOrganizationId,
  brandPersistedUserId,
} from "@/api/lib/safe-id-boundaries";
import { signInHuman } from "@/api/tests/helpers/human-session";
import {
  initAgentAuthTestDb,
  releaseAgentAuthTestDb,
} from "@/api/tests/helpers/mock-agent-auth-db";
import type { TestDatabase } from "@/api/tests/security/test-utils";

setDefaultTimeout(120_000);

let testDb: TestDatabase;

beforeAll(async () => {
  testDb = await initAgentAuthTestDb();
});

afterAll(async () => {
  await releaseAgentAuthTestDb();
});

const createMemberWithActiveTimer = async (dateWorked: string) => {
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
  const globalTimerId = createSafeId<"timeTimer">();
  await testDb.insert(timeTimers).values({
    id: globalTimerId,
    organizationId,
    userId,
    workspaceId,
    state: "running",
    startedAt: new Date(Date.now() - 120_000),
    lastResumedAt: new Date(Date.now() - 120_000),
    accumulatedSeconds: 17,
    description: "Research",
  });
  await testDb.insert(timeEntries).values({
    id: timerId,
    organizationId,
    workspaceId,
    userId,
    dateWorked,
    timezoneId: "UTC",
    durationMinutes: 0,
    billedMinutes: 0,
    rateAtEntry: cents(100),
    currency: "USD",
    narrative: "",
    source: "timer",
    timerStartedAt: new Date(Date.now() - 120_000),
  });
  return {
    auth,
    invitee,
    organization,
    organizationId,
    owner,
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
      accumulatedSeconds: 17,
    });
  });

  test("closes an unlocked timer and removes the member", async () => {
    const fixture = await createMemberWithActiveTimer("2025-02-01");
    await testDb.insert(organizationSettings).values({
      id: createSafeId<"organizationSettings">(),
      organizationId: fixture.organizationId,
      timeLockedThroughMonth: "2025-01-31",
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
        billedMinutes: timeEntries.billedMinutes,
        timerStartedAt: timeEntries.timerStartedAt,
        timerStoppedAt: timeEntries.timerStoppedAt,
      })
      .from(timeEntries)
      .where(eq(timeEntries.id, fixture.timerId));
    expect(remainingMember).toBeUndefined();
    expect(stoppedTimer?.timerStartedAt).toBeNull();
    expect(stoppedTimer?.timerStoppedAt).toBeInstanceOf(Date);
    expect(stoppedTimer?.billedMinutes).toBe(15);
    const globalTimer = await testDb.query.timeTimers.findFirst({
      where: { id: { eq: fixture.globalTimerId } },
    });
    expect(globalTimer).toMatchObject({ state: "paused", lastResumedAt: null });
    expect(globalTimer?.accumulatedSeconds).toBeGreaterThanOrEqual(137);
  });
});
