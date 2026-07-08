import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { member, organization, user } from "@/api/db/auth-schema";
import { contacts, workspaceMembers, workspaces } from "@/api/db/schema";
import { resolveMemberAccess } from "@/api/lib/auth";
import type { SafeId } from "@/api/lib/branded-types";
import { toSafeId } from "@/api/lib/branded-types";
import { getTestDb, releaseTestDb } from "@/api/tests/security/test-utils";
import type { TestDatabase } from "@/api/tests/security/test-utils";

// resolveMemberAccess replaced a member-role lookup + a role-dependent
// accessible-workspaces lookup with a single LEFT JOIN. These tests pin
// down the matrix the two original queries covered between them: role
// resolution for owner/admin vs. regular members, crossed with orgs that
// have client + personal workspaces, orgs with zero workspaces, and a
// member who belongs to the org but to none of its workspaces (the case
// the merge is not allowed to regress into a false 401 — see the JOIN's
// ON-clause-not-WHERE-clause comment on resolveMemberAccess).

const tid = () => Bun.randomUUIDv7();
const orgId = () => toSafeId<"organization">(tid());
const userId = () => toSafeId<"user">(tid());
const wsId = () => toSafeId<"workspace">(tid());
const wsMemberId = () => toSafeId<"workspaceMember">(tid());

let testDb: TestDatabase;

// One shared fixture across all tests in this file: two organizations,
// each with owner + member accounts, and a variety of workspace shapes.
const orgFull = orgId();
const ownerInFull = userId();
const memberInFull = userId();
const loneMemberInFull = userId();

const orgEmpty = orgId();
const ownerInEmpty = userId();
const memberInEmpty = userId();

const strangerUser = userId();

const clientContact = toSafeId<"contact">(tid());
const clientWs = wsId();
const personalWsOwner = wsId();
const personalWsMember = wsId();
const archivedWs = wsId();

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

  await testDb.insert(contacts).values([
    {
      id: clientContact,
      organizationId: orgFull,
      type: "person" as const,
      displayName: "Client contact",
    },
  ]);

  // clientWs: a client matter (clientId not null) in orgFull. Neither
  // owner nor member is an explicit workspace_members row here — the
  // admin bypass must still surface it for the owner via clientId, but
  // NOT for the regular member (added to workspaceMembers separately
  // below to prove membership, not clientId, drives their access).
  await testDb.insert(workspaces).values([
    {
      id: clientWs,
      organizationId: orgFull,
      clientId: clientContact,
      name: "Client matter",
      reference: "CW-1",
      status: "active" as const,
    },
    {
      id: personalWsOwner,
      organizationId: orgFull,
      clientId: null,
      name: "Owner's personal workspace",
      reference: "PW-OWNER",
      status: "active" as const,
    },
    {
      id: personalWsMember,
      organizationId: orgFull,
      clientId: null,
      name: "Member's personal workspace",
      reference: "PW-MEMBER",
      status: "active" as const,
    },
    {
      id: archivedWs,
      organizationId: orgFull,
      clientId: null,
      name: "Archived personal workspace",
      reference: "PW-ARCHIVED",
      status: "archived" as const,
    },
  ]);

  await testDb.insert(workspaceMembers).values([
    { id: wsMemberId(), workspaceId: personalWsOwner, userId: ownerInFull },
    { id: wsMemberId(), workspaceId: personalWsMember, userId: memberInFull },
    { id: wsMemberId(), workspaceId: clientWs, userId: memberInFull },
    { id: wsMemberId(), workspaceId: archivedWs, userId: memberInFull },
  ]);
});

afterAll(async () => {
  await releaseTestDb();
});

const idsOf = (result: { id: SafeId<"workspace"> }[]) =>
  result.map((w) => w.id).sort();

describe("resolveMemberAccess", () => {
  test("owner sees every client workspace plus their own personal workspaces, not other members' personal workspaces", async () => {
    const result = await resolveMemberAccess(ownerInFull, orgFull, testDb);

    expect(result?.role).toBe("owner");
    expect(idsOf(result?.accessibleWorkspaces ?? [])).toEqual(
      idsOf([{ id: clientWs }, { id: personalWsOwner }]),
    );
  });

  test("regular member sees only workspaces they are an explicit member of, including a client matter", async () => {
    const result = await resolveMemberAccess(memberInFull, orgFull, testDb);

    expect(result?.role).toBe("member");
    expect(idsOf(result?.accessibleWorkspaces ?? [])).toEqual(
      idsOf([{ id: personalWsMember }, { id: clientWs }, { id: archivedWs }]),
    );
  });

  test("workspace status passes through unfiltered (archived included)", async () => {
    const result = await resolveMemberAccess(memberInFull, orgFull, testDb);

    const archived = result?.accessibleWorkspaces.find(
      (w) => w.id === archivedWs,
    );
    expect(archived?.status).toBe("archived");
  });

  test("a member belonging to the org but to none of its workspaces still resolves their role, not null", async () => {
    const result = await resolveMemberAccess(loneMemberInFull, orgFull, testDb);

    expect(result).not.toBeNull();
    expect(result?.role).toBe("member");
    expect(result?.accessibleWorkspaces).toEqual([]);
  });

  test("owner of an organization with zero workspaces resolves role with an empty workspace list", async () => {
    const result = await resolveMemberAccess(ownerInEmpty, orgEmpty, testDb);

    expect(result?.role).toBe("owner");
    expect(result?.accessibleWorkspaces).toEqual([]);
  });

  test("member of an organization with zero workspaces resolves role with an empty workspace list", async () => {
    const result = await resolveMemberAccess(memberInEmpty, orgEmpty, testDb);

    expect(result?.role).toBe("member");
    expect(result?.accessibleWorkspaces).toEqual([]);
  });

  test("a user with no membership row in the organization resolves to null", async () => {
    const result = await resolveMemberAccess(strangerUser, orgFull, testDb);

    expect(result).toBeNull();
  });

  test("membership in one organization does not leak workspace access when queried against another organization", async () => {
    const result = await resolveMemberAccess(ownerInFull, orgEmpty, testDb);

    expect(result).toBeNull();
  });
});
