import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";

import { member, organization, user } from "@/api/db/auth-schema";
import { contacts, workspaceMembers, workspaces } from "@/api/db/schema";
import { resolveMemberAuthorization } from "@/api/lib/auth";
import { toSafeId } from "@/api/lib/branded-types";
import { getTestDb, releaseTestDb } from "@/api/tests/security/test-utils";
import type { TestDatabase } from "@/api/tests/security/test-utils";

setDefaultTimeout(120_000);

// Authentication resolves one organization membership row. A target workspace
// is joined only when supplied, so the common auth query stays one row even as
// the organization accumulates matters.

const tid = () => Bun.randomUUIDv7();
const orgId = () => toSafeId<"organization">(tid());
const userId = () => toSafeId<"user">(tid());
const workspaceId = () => toSafeId<"workspace">(tid());

let testDb: TestDatabase;

// One shared fixture across all tests in this file.
const orgFull = orgId();
const ownerInFull = userId();
const memberInFull = userId();
const loneMemberInFull = userId();

const orgEmpty = orgId();
const ownerInEmpty = userId();
const memberInEmpty = userId();

const strangerUser = userId();
const clientContactId = toSafeId<"contact">(tid());
const clientWorkspaceId = workspaceId();
const memberPersonalWorkspaceId = workspaceId();

beforeAll(async () => {
  testDb = await getTestDb();

  await testDb.insert(user).values(
    [
      ownerInFull,
      memberInFull,
      loneMemberInFull,
      ownerInEmpty,
      memberInEmpty,
      strangerUser,
    ].map((id) => ({
      id,
      name: `user-${id}`,
      email: `${id}@test.local`,
    })),
  );

  await testDb.insert(organization).values([
    {
      id: orgFull,
      name: "Org Full",
      slug: `org-full-${orgFull}`,
      createdAt: new Date(),
    },
    {
      id: orgEmpty,
      name: "Org Empty",
      slug: `org-empty-${orgEmpty}`,
      createdAt: new Date(),
    },
  ]);

  await testDb.insert(member).values([
    {
      id: tid(),
      organizationId: orgFull,
      userId: ownerInFull,
      role: "owner",
      createdAt: new Date(),
    },
    {
      id: tid(),
      organizationId: orgFull,
      userId: memberInFull,
      role: "member",
      createdAt: new Date(),
    },
    {
      id: tid(),
      organizationId: orgFull,
      userId: loneMemberInFull,
      role: "member",
      createdAt: new Date(),
    },
    {
      id: tid(),
      organizationId: orgEmpty,
      userId: ownerInEmpty,
      role: "owner",
      createdAt: new Date(),
    },
    {
      id: tid(),
      organizationId: orgEmpty,
      userId: memberInEmpty,
      role: "member",
      createdAt: new Date(),
    },
  ]);

  await testDb.insert(contacts).values({
    id: clientContactId,
    organizationId: orgFull,
    type: "person",
    displayName: "Client",
  });
  await testDb.insert(workspaces).values([
    {
      id: clientWorkspaceId,
      organizationId: orgFull,
      clientId: clientContactId,
      name: "Client matter",
      reference: "AUTH-CLIENT",
    },
    {
      id: memberPersonalWorkspaceId,
      organizationId: orgFull,
      clientId: null,
      name: "Member personal matter",
      reference: "AUTH-PERSONAL",
    },
  ]);
  await testDb.insert(workspaceMembers).values({
    id: toSafeId<"workspaceMember">(tid()),
    workspaceId: memberPersonalWorkspaceId,
    userId: memberInFull,
  });
});

afterAll(async () => {
  await releaseTestDb();
});

describe("resolveMemberAuthorization", () => {
  test("resolves an owner without loading workspaces", async () => {
    const authorization = await resolveMemberAuthorization(
      { organizationId: orgFull, userId: ownerInFull },
      testDb,
    );

    expect(authorization).toEqual({ role: "owner", workspace: null });
  });

  test("a member belonging to the org but to no workspace still resolves", async () => {
    const authorization = await resolveMemberAuthorization(
      { organizationId: orgFull, userId: loneMemberInFull },
      testDb,
    );
    expect(authorization).toEqual({ role: "member", workspace: null });
  });

  test("optionally resolves one target workspace without expanding the access set", async () => {
    const ownerClient = await resolveMemberAuthorization(
      {
        organizationId: orgFull,
        userId: ownerInFull,
        workspaceId: clientWorkspaceId,
      },
      testDb,
    );
    const ownerPersonal = await resolveMemberAuthorization(
      {
        organizationId: orgFull,
        userId: ownerInFull,
        workspaceId: memberPersonalWorkspaceId,
      },
      testDb,
    );
    const memberPersonal = await resolveMemberAuthorization(
      {
        organizationId: orgFull,
        userId: memberInFull,
        workspaceId: memberPersonalWorkspaceId,
      },
      testDb,
    );
    const memberClient = await resolveMemberAuthorization(
      {
        organizationId: orgFull,
        userId: memberInFull,
        workspaceId: clientWorkspaceId,
      },
      testDb,
    );

    expect(ownerClient?.workspace?.id).toBe(clientWorkspaceId);
    expect(ownerPersonal?.workspace).toBeNull();
    expect(memberPersonal?.workspace?.id).toBe(memberPersonalWorkspaceId);
    expect(memberClient?.workspace).toBeNull();
  });

  test("organization members with zero workspaces keep their roles", async () => {
    const ownerAuthorization = await resolveMemberAuthorization(
      { organizationId: orgEmpty, userId: ownerInEmpty },
      testDb,
    );
    const memberAuthorization = await resolveMemberAuthorization(
      { organizationId: orgEmpty, userId: memberInEmpty },
      testDb,
    );
    expect(ownerAuthorization?.role).toBe("owner");
    expect(memberAuthorization?.role).toBe("member");
  });

  test("a user with no membership row in the organization resolves to null", async () => {
    const result = await resolveMemberAuthorization(
      { organizationId: orgFull, userId: strangerUser },
      testDb,
    );

    expect(result).toBeNull();
  });

  test("membership in one organization does not leak workspace access when queried against another organization", async () => {
    const result = await resolveMemberAuthorization(
      { organizationId: orgEmpty, userId: ownerInFull },
      testDb,
    );

    expect(result).toBeNull();
  });
});
