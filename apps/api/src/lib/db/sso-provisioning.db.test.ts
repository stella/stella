import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";

import { createTestClock } from "@stll/test-kit";

import { member, organization, user } from "@/api/db/auth-schema";
import {
  ORGANIZATION_ACCESS_STATE,
  organizationAccessStates,
} from "@/api/db/schema";
import { updateOrganizationSsoRequirement } from "@/api/lib/db/sso-management";
import {
  approveOrganizationSsoPendingMember,
  countOrganizationActiveSeats,
  listOrganizationPendingSsoMembers,
  provisionSsoMemberOnSignIn,
  rejectOrganizationSsoPendingMember,
} from "@/api/lib/db/sso-provisioning";
import {
  brandPersistedOrganizationId,
  brandPersistedUserId,
} from "@/api/lib/safe-id-boundaries";
import {
  initAgentAuthTestDb,
  releaseAgentAuthTestDb,
} from "@/api/tests/helpers/mock-agent-auth-db";
import type { TestDatabase } from "@/api/tests/security/test-utils";

const clock = createTestClock({ start: Date.parse("2026-11-23T14:00:00.000Z") });
const unique = (prefix: string) =>
  `${prefix}-${Bun.randomUUIDv7().replaceAll("-", "").slice(-10)}`;

let testDb: TestDatabase;

beforeAll(async () => {
  testDb = await initAgentAuthTestDb();
});

afterAll(async () => {
  await releaseAgentAuthTestDb();
});

const insertUser = async (email: string) => {
  const id = unique("user");
  await testDb.insert(user).values({
    id,
    name: "SSO User",
    email,
    emailVerified: true,
  });
  return brandPersistedUserId(id);
};

const insertOrg = async (name: string) => {
  const id = unique("org");
  await testDb.insert(organization).values({
    id,
    name,
    slug: id,
    createdAt: new Date(clock.now()),
  });
  const orgId = brandPersistedOrganizationId(id);
  await testDb.insert(organizationAccessStates).values({
    organizationId: orgId,
    state: ORGANIZATION_ACCESS_STATE.selfManagedKeys,
  });
  return orgId;
};

describe("sso-provisioning", () => {
  test("enforces seat limits on JIT provisioning and gates approval until a seat opens", async () => {
    const adminId = await insertUser(`${unique("adm")}@bank.example.com`);
    const emp1 = await insertUser(`${unique("e1")}@bank.example.com`);
    const emp2 = await insertUser(`${unique("e2")}@bank.example.com`);
    const orgId = await insertOrg("Bank");

    await testDb.insert(member).values({
      id: unique("mem"),
      organizationId: orgId,
      userId: adminId,
      role: "owner",
      createdAt: new Date(clock.now()),
    });

    // Set jit_active with seatLimit = 2 (admin already occupies 1).
    const policy = await updateOrganizationSsoRequirement(testDb, {
      organizationId: orgId,
      requirement: "optional",
      provisioningMode: "jit_active",
      seatLimit: 2,
    });
    expect(policy.isOk()).toBe(true);

    // First employee activates automatically (seats: 2/2).
    const first = await provisionSsoMemberOnSignIn(testDb, {
      organizationId: orgId,
      userId: emp1,
      email: "emp1@bank.example.com",
      name: "Employee One",
      ssoProviderId: null,
      now: new Date(clock.now()),
    });
    expect(first.status).toBe("activated");
    expect(await countOrganizationActiveSeats(testDb, orgId)).toBe(2);

    // Second employee lands in pending (seat_limit_reached).
    const second = await provisionSsoMemberOnSignIn(testDb, {
      organizationId: orgId,
      userId: emp2,
      email: "emp2@bank.example.com",
      name: "Employee Two",
      ssoProviderId: null,
      now: new Date(clock.now()),
    });
    expect(second.status).toBe("pending");
    if (second.status !== "pending") {
      return;
    }
    expect(second.reason).toBe("seat_limit_reached");
    expect(await listOrganizationPendingSsoMembers(testDb, orgId)).toHaveLength(
      1,
    );

    // Admin approval is blocked while at 2/2 seats.
    const blocked = await approveOrganizationSsoPendingMember(testDb, {
      organizationId: orgId,
      pendingId: second.pendingId,
      reviewedBy: adminId,
      now: new Date(clock.now()),
    });
    expect(blocked.isErr()).toBe(true);
    if (blocked.isErr()) {
      expect(blocked.error.reason).toBe("seat_limit_reached");
    }

    // Remove emp1 to free a seat -> approval now succeeds.
    await testDb
      .delete(member)
      .where(and(eq(member.organizationId, orgId), eq(member.userId, emp1)));

    const approved = await approveOrganizationSsoPendingMember(testDb, {
      organizationId: orgId,
      pendingId: second.pendingId,
      reviewedBy: adminId,
      now: new Date(clock.now()),
    });
    expect(approved.isOk()).toBe(true);
    expect(await countOrganizationActiveSeats(testDb, orgId)).toBe(2);
    expect(await listOrganizationPendingSsoMembers(testDb, orgId)).toHaveLength(
      0,
    );
  });

  test("admin_approval queues users and reject leaves no membership", async () => {
    const adminId = await insertUser(`${unique("adm2")}@law.example.com`);
    const applicant = await insertUser(`${unique("app")}@law.example.com`);
    const orgId = await insertOrg("Law Firm");

    await updateOrganizationSsoRequirement(testDb, {
      organizationId: orgId,
      requirement: "optional",
      provisioningMode: "admin_approval",
      seatLimit: null,
    });

    const outcome = await provisionSsoMemberOnSignIn(testDb, {
      organizationId: orgId,
      userId: applicant,
      email: "applicant@law.example.com",
      name: "Applicant",
      ssoProviderId: null,
      now: new Date(clock.now()),
    });
    expect(outcome.status).toBe("pending");
    if (outcome.status !== "pending") {
      return;
    }
    expect(outcome.reason).toBe("admin_approval");

    const rejected = await rejectOrganizationSsoPendingMember(testDb, {
      organizationId: orgId,
      pendingId: outcome.pendingId,
      reviewedBy: adminId,
      now: new Date(clock.now()),
    });
    expect(rejected.isOk()).toBe(true);
    expect(await countOrganizationActiveSeats(testDb, orgId)).toBe(0);
    expect(await listOrganizationPendingSsoMembers(testDb, orgId)).toHaveLength(
      0,
    );
  });
});
