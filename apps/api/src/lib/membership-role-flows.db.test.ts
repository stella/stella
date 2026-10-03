import { panic, Result } from "better-result";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { and, eq } from "drizzle-orm";

import { TIME_ENTRY_ACTIVITY_GROUP } from "@stll/api-contract";
import { roles } from "@stll/permissions";

import {
  member,
  organization as organizationTable,
  user,
} from "@/api/db/auth-schema";
import { timeEntries, timeTimers } from "@/api/db/schema";
import { getAuth } from "@/api/lib/auth";
import { UNPRICED_TIME_ENTRY_CURRENCY } from "@/api/lib/billing-constants";
import { createSafeId } from "@/api/lib/branded-types";
import { createConfirmationOtp } from "@/api/lib/confirmation-otp";
import {
  ACCOUNT_DELETION_ERROR_CODE,
  verifyAndDeleteUser,
} from "@/api/lib/delete-account";
import { isMemberRole } from "@/api/lib/member-roles";
import { OWNER_REQUIRED_ERROR_CODE } from "@/api/lib/membership-role-invariants";
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
const getTestDatabase = () => testDb;
beforeAll(async () => {
  testDb = await initAgentAuthTestDb();
});
afterAll(async () => {
  await releaseAgentAuthTestDb();
});
const createOrganization = async () => {
  const owner = await signInHuman(
    `role-flow-owner-${Bun.randomUUIDv7()}@stella.dev`,
  );
  const auth = getAuth();
  const organization = await auth.api.createOrganization({
    body: { name: "Membership roles", slug: `role-flow-${Bun.randomUUIDv7()}` },
    headers: owner.headers(),
  });
  await owner.setActiveOrganization(organization.id);
  return { auth, owner, organization };
};
const productRoles = Object.keys(roles).filter(isMemberRole);

describe("live organization ownership", () => {
  test("ownership transfer promotes the successor before demoting the previous owner", async () => {
    const { auth, owner, organization } = await createOrganization();
    const successor = await signInHuman(
      `role-successor-${Bun.randomUUIDv7()}@stella.dev`,
    );
    const added = await auth.api.addMember({
      body: {
        organizationId: organization.id,
        userId: successor.userId,
        role: "member",
      },
      headers: owner.headers(),
    });
    const initialOwners = await getTestDatabase()
      .select()
      .from(member)
      .where(
        and(
          eq(member.organizationId, organization.id),
          eq(member.role, "owner"),
        ),
      );
    expect(initialOwners).toHaveLength(1);
    const previousOwner = initialOwners.at(0);
    if (!previousOwner) {
      panic("Ownership transfer requires an existing owner");
    }
    const promotion = await auth.api.updateMemberRole({
      body: {
        organizationId: organization.id,
        memberId: added.id,
        role: "owner",
      },
      headers: owner.headers(),
      asResponse: true,
    });
    expect(promotion.status).toBe(200);
    expect(
      await getTestDatabase()
        .select()
        .from(member)
        .where(
          and(
            eq(member.organizationId, organization.id),
            eq(member.role, "owner"),
          ),
        ),
    ).toHaveLength(2);
    await successor.setActiveOrganization(organization.id);
    const demotion = await auth.api.updateMemberRole({
      body: {
        organizationId: organization.id,
        memberId: previousOwner.id,
        role: "admin",
      },
      headers: successor.headers(),
      asResponse: true,
    });
    expect(demotion.status).toBe(200);
    expect(
      await getTestDatabase()
        .select({ userId: member.userId, role: member.role })
        .from(member)
        .where(
          and(
            eq(member.organizationId, organization.id),
            eq(member.role, "owner"),
          ),
        ),
    ).toEqual([{ userId: successor.userId, role: "owner" }]);
    expect(
      await getTestDatabase()
        .select({ role: member.role })
        .from(member)
        .where(eq(member.id, previousOwner.id)),
    ).toEqual([{ role: "admin" }]);
  });

  test("account deletion drops ownership in multiple organizations that each retain another owner", async () => {
    const { auth, owner, organization } = await createOrganization();
    const second = await auth.api.createOrganization({
      body: {
        name: "Second membership",
        slug: `role-second-${Bun.randomUUIDv7()}`,
      },
      headers: owner.headers(),
    });
    const coowner = await signInHuman(
      `role-coowner-${Bun.randomUUIDv7()}@stella.dev`,
    );
    const organizationIds = [organization.id, second.id];
    for (const organizationId of organizationIds) {
      await auth.api.addMember({
        body: { organizationId, userId: coowner.userId, role: "owner" },
        headers: owner.headers(),
      });
      expect(
        await getTestDatabase()
          .select()
          .from(member)
          .where(
            and(
              eq(member.organizationId, organizationId),
              eq(member.role, "owner"),
            ),
          ),
      ).toHaveLength(2);
    }
    const otp = await createConfirmationOtp({
      purpose: "delete-account",
      email: owner.email,
    });
    if (Result.isError(otp)) {
      panic(otp.error.message);
    }
    const deletion = await verifyAndDeleteUser(
      brandPersistedUserId(owner.userId),
      owner.email,
      otp.value,
    );
    expect(Result.isOk(deletion)).toBe(true);
    if (Result.isError(deletion)) {
      panic(deletion.error.message);
    }
    expect(
      await getTestDatabase()
        .select()
        .from(member)
        .where(eq(member.userId, owner.userId)),
    ).toEqual([]);
    for (const organizationId of organizationIds) {
      expect(
        await getTestDatabase()
          .select({ userId: member.userId, role: member.role })
          .from(member)
          .where(eq(member.organizationId, organizationId)),
      ).toEqual([{ userId: coowner.userId, role: "owner" }]);
      expect(
        await getTestDatabase()
          .select()
          .from(organizationTable)
          .where(eq(organizationTable.id, organizationId)),
      ).toHaveLength(1);
    }
    const deletedAccount = await getTestDatabase()
      .select()
      .from(user)
      .where(eq(user.id, owner.userId));
    expect(deletedAccount.at(0)).toMatchObject({
      name: "Deleted account",
      deletedAt: expect.any(Date),
      emailVerified: false,
    });
    expect(deletedAccount.at(0)?.email).not.toBe(owner.email);
  });

  test("member offboarding closes its active timer while preserving the organization's owner", async () => {
    const { auth, owner, organization } = await createOrganization();
    const departing = await signInHuman(
      `role-departing-${Bun.randomUUIDv7()}@stella.dev`,
    );
    const invitation = await auth.api.createInvitation({
      body: {
        organizationId: organization.id,
        email: departing.email,
        role: "member",
      },
      headers: owner.headers(),
    });
    await auth.api.acceptInvitation({
      body: { invitationId: invitation.id },
      headers: departing.headers(),
    });
    const organizationId = brandPersistedOrganizationId(organization.id);
    const userId = brandPersistedUserId(departing.userId);
    const entryId = createSafeId<"timeEntry">();
    const timerId = createSafeId<"timeTimer">();
    const startedAt = new Date(Date.now() - 60_000);
    await getTestDatabase()
      .insert(timeEntries)
      .values({
        id: entryId,
        organizationId,
        userId,
        activityGroup: TIME_ENTRY_ACTIVITY_GROUP.INTERNAL,
        dateWorked: startedAt.toISOString().slice(0, 10),
        timezoneId: "UTC",
        durationMinutes: 0,
        billedMinutes: 0,
        rateAtEntry: cents(0),
        billable: false,
        currency: UNPRICED_TIME_ENTRY_CURRENCY,
        narrative: "",
        source: "timer",
        timerStartedAt: startedAt,
      });
    await getTestDatabase().insert(timeTimers).values({
      id: timerId,
      organizationId,
      userId,
      legacyTimeEntryId: entryId,
      state: "running",
      startedAt,
      lastResumedAt: startedAt,
    });
    const removal = await auth.api.removeMember({
      body: {
        organizationId: organization.id,
        memberIdOrEmail: departing.email,
      },
      headers: owner.headers(),
      asResponse: true,
    });
    expect(removal.status).toBe(200);
    expect(
      await getTestDatabase()
        .select()
        .from(member)
        .where(
          and(
            eq(member.organizationId, organization.id),
            eq(member.userId, departing.userId),
          ),
        ),
    ).toEqual([]);
    const entries = await getTestDatabase()
      .select()
      .from(timeEntries)
      .where(eq(timeEntries.id, entryId));
    expect(entries.at(0)).toMatchObject({
      timerStartedAt: null,
      timerStoppedAt: expect.any(Date),
      billedMinutes: 0,
    });
    const timers = await getTestDatabase()
      .select()
      .from(timeTimers)
      .where(eq(timeTimers.id, timerId));
    expect(timers.at(0)).toMatchObject({ state: "paused" });
    expect(
      await getTestDatabase()
        .select({ userId: member.userId, role: member.role })
        .from(member)
        .where(eq(member.organizationId, organization.id)),
    ).toEqual([{ userId: owner.userId, role: "owner" }]);
  });
  test("last-owner role changes and removal return typed refusals without persistence", async () => {
    const { auth, owner, organization } = await createOrganization();
    const before = await getTestDatabase()
      .select()
      .from(member)
      .where(eq(member.organizationId, organization.id));
    const ownerMember = before.at(0);
    if (!ownerMember) {
      panic("Organization creation did not persist its owner");
    }
    for (const role of productRoles.filter(
      (targetRole) => targetRole !== "owner",
    )) {
      const response = await auth.api.updateMemberRole({
        body: {
          organizationId: organization.id,
          memberId: ownerMember.id,
          role,
        },
        headers: owner.headers(),
        asResponse: true,
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        code: OWNER_REQUIRED_ERROR_CODE,
      });
      expect(
        await getTestDatabase()
          .select()
          .from(member)
          .where(eq(member.organizationId, organization.id)),
      ).toEqual(before);
    }
    const removal = await auth.api.removeMember({
      body: { organizationId: organization.id, memberIdOrEmail: owner.email },
      headers: owner.headers(),
      asResponse: true,
    });
    expect(removal.status).toBe(400);
    expect(await removal.json()).toMatchObject({
      code: "YOU_CANNOT_LEAVE_THE_ORGANIZATION_AS_THE_ONLY_OWNER",
    });
    expect(
      await getTestDatabase()
        .select()
        .from(member)
        .where(eq(member.organizationId, organization.id)),
    ).toEqual(before);
  });

  test("organization deletion cascades its last owner through real auth", async () => {
    const { auth, owner, organization } = await createOrganization();
    expect(
      await getTestDatabase()
        .select()
        .from(member)
        .where(eq(member.organizationId, organization.id)),
    ).toHaveLength(1);
    const deletion = await auth.api.deleteOrganization({
      body: { organizationId: organization.id },
      headers: owner.headers(),
      asResponse: true,
    });
    expect(deletion.status).toBe(200);
    expect(
      await getTestDatabase()
        .select()
        .from(organizationTable)
        .where(eq(organizationTable.id, organization.id)),
    ).toEqual([]);
    expect(
      await getTestDatabase()
        .select()
        .from(member)
        .where(eq(member.organizationId, organization.id)),
    ).toEqual([]);
    expect(
      await getTestDatabase()
        .select()
        .from(user)
        .where(eq(user.id, owner.userId)),
    ).toHaveLength(1);
  });

  test("account deletion preserves its existing last-owner refusal and account", async () => {
    const { owner, organization } = await createOrganization();
    const beforeMembers = await getTestDatabase()
      .select()
      .from(member)
      .where(eq(member.organizationId, organization.id));
    const beforeUser = await getTestDatabase()
      .select()
      .from(user)
      .where(eq(user.id, owner.userId));
    const otp = await createConfirmationOtp({
      purpose: "delete-account",
      email: owner.email,
    });
    if (Result.isError(otp)) {
      panic(otp.error.message);
    }
    const deletion = await verifyAndDeleteUser(
      brandPersistedUserId(owner.userId),
      owner.email,
      otp.value,
    );
    expect(Result.isError(deletion)).toBe(true);
    if (Result.isOk(deletion)) {
      panic("A last owner's account deletion succeeded");
    }
    expect(deletion.error).toMatchObject({
      code: ACCOUNT_DELETION_ERROR_CODE.soleOwner,
      status: 400,
    });
    expect(
      await getTestDatabase()
        .select()
        .from(user)
        .where(eq(user.id, owner.userId)),
    ).toEqual(beforeUser);
    expect(
      await getTestDatabase()
        .select()
        .from(member)
        .where(eq(member.organizationId, organization.id)),
    ).toEqual(beforeMembers);
  });
});
