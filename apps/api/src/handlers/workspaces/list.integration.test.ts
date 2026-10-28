import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { eq } from "drizzle-orm";

import {
  member as memberTable,
  organization,
  user,
} from "@/api/db/auth-schema";
import {
  workspaceMembers,
  workspaces as workspaceTable,
} from "@/api/db/schema";
import { createSafeDb } from "@/api/db/scoped";
import type { ApiRoutePath } from "@/api/http/api-route-types";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

import readWorkspaces from "./list";

// Every identity in the members payload arrives through `workspace_members`
// rows of the organization's own matters, joined to organization membership.
// `user` is readable under RLS for any member of the active organization
// (`auth_user_select`), so organization membership alone is not what keeps a
// colleague out of a matter's member list — the workspace join is.

setDefaultTimeout(120_000);

let testDb: TestDatabase;
let ids: TestIds;

const statusFilterIds = {
  organization: mintAuthProviderId<"organization">(),
  user: mintAuthProviderId<"user">(),
  activeWorkspaces: [createSafeId<"workspace">(), createSafeId<"workspace">()],
  archivedWorkspaces: [
    createSafeId<"workspace">(),
    createSafeId<"workspace">(),
  ],
};

const statusFilterWorkspaceIds = [
  ...statusFilterIds.activeWorkspaces,
  ...statusFilterIds.archivedWorkspaces,
];

type ListedMember = {
  userId: string;
  userEmail: string | null;
  userName: string | null;
};

type ListedWorkspace = {
  id: SafeId<"workspace">;
  members: ListedMember[];
};

beforeAll(async () => {
  const fixture = await getRlsFixture();
  testDb = fixture.testDb;
  ids = fixture.ids;

  await testDb.insert(user).values({
    id: statusFilterIds.user,
    name: "Matter status filter member",
    email: `${statusFilterIds.user}@test.local`,
  });
  await testDb.insert(organization).values({
    id: statusFilterIds.organization,
    name: "Matter status filter organization",
    slug: statusFilterIds.organization,
    createdAt: new Date(),
  });
  await testDb.insert(memberTable).values({
    id: Bun.randomUUIDv7(),
    organizationId: statusFilterIds.organization,
    userId: statusFilterIds.user,
    role: "owner",
    createdAt: new Date(),
  });
  await testDb.insert(workspaceTable).values([
    ...statusFilterIds.activeWorkspaces.map((id, index) => ({
      id,
      organizationId: statusFilterIds.organization,
      name: `Matter status filter ${index}`,
      reference: `STATUS-${index}`,
      status: "active" as const,
    })),
    ...statusFilterIds.archivedWorkspaces.map((id, index) => ({
      id,
      organizationId: statusFilterIds.organization,
      name: `Archived matter status filter ${index}`,
      reference: `ARCHIVED-STATUS-${index}`,
      status: "archived" as const,
    })),
  ]);
  await testDb.insert(workspaceMembers).values(
    statusFilterWorkspaceIds.map((workspaceId) => ({
      id: createSafeId<"workspaceMember">(),
      workspaceId,
      userId: statusFilterIds.user,
    })),
  );
});

afterAll(async () => {
  await testDb
    .delete(organization)
    .where(eq(organization.id, statusFilterIds.organization));
  await testDb.delete(user).where(eq(user.id, statusFilterIds.user));
  await releaseRlsFixture();
});

const listWorkspacesAs = async ({
  organizationId,
  status,
  userId,
  workspaceIds,
}: {
  organizationId: SafeId<"organization">;
  status?: "active" | "archived";
  userId: SafeId<"user">;
  workspaceIds: SafeId<"workspace">[];
}): Promise<ListedWorkspace[]> => {
  const result = await readWorkspaces.handler(
    asTestRaw<Parameters<typeof readWorkspaces.handler>[0]>({
      request: new Request("https://api.example.test/handler"),
      route: "/v1/workspaces" satisfies ApiRoutePath,
      query: status ? { status } : {},
      memberRole: sessionMemberRole("owner"),
      safeDb: createSafeDb(testDb, workspaceIds, organizationId, userId),
      session: { activeOrganizationId: organizationId },
      user: { id: userId },
    }),
  );
  return asTestRaw<{ workspaces: ListedWorkspace[] }>(result).workspaces;
};

const emailsIn = (workspaces: ListedWorkspace[]): (string | null)[] =>
  workspaces.flatMap((workspace) =>
    workspace.members.map((member) => member.userEmail),
  );

describe("matter list status", () => {
  test("returns exactly archived matters when archived is requested", async () => {
    const rows = await listWorkspacesAs({
      organizationId: statusFilterIds.organization,
      status: "archived",
      userId: statusFilterIds.user,
      workspaceIds: statusFilterWorkspaceIds,
    });

    expect(rows.map(({ id }) => id).toSorted()).toEqual(
      statusFilterIds.archivedWorkspaces.toSorted(),
    );
  });

  test("returns exactly active matters when active is requested", async () => {
    const rows = await listWorkspacesAs({
      organizationId: statusFilterIds.organization,
      status: "active",
      userId: statusFilterIds.user,
      workspaceIds: statusFilterWorkspaceIds,
    });

    expect(rows.map(({ id }) => id).toSorted()).toEqual(
      statusFilterIds.activeWorkspaces.toSorted(),
    );
  });

  test("defaults the handler to active matters", async () => {
    const rows = await listWorkspacesAs({
      organizationId: statusFilterIds.organization,
      userId: statusFilterIds.user,
      workspaceIds: statusFilterWorkspaceIds,
    });

    expect(rows.map(({ id }) => id).toSorted()).toEqual(
      statusFilterIds.activeWorkspaces.toSorted(),
    );
  });
});

describe("matter list member identities", () => {
  test("exposes exactly the users who are members of the organization's own matters", async () => {
    const workspaces = await listWorkspacesAs({
      organizationId: ids.orgA,
      userId: ids.userA1,
      workspaceIds: [ids.wsA1, ids.wsA2],
    });

    const membersByWorkspace = new Map(
      workspaces.map((workspace) => [
        workspace.id,
        workspace.members.map((member) => member.userId).toSorted(),
      ]),
    );
    expect(membersByWorkspace.get(ids.wsA1)).toEqual([ids.userA1]);
    expect(membersByWorkspace.get(ids.wsA2)).toEqual(
      [ids.userA1, ids.userA2].toSorted(),
    );
  });

  test("an organization member who belongs to no matter never appears, though RLS makes the row readable", async () => {
    const workspaces = await listWorkspacesAs({
      organizationId: ids.orgA,
      userId: ids.userA1,
      workspaceIds: [ids.wsA1, ids.wsA2],
    });

    // The administrator is a member of organization A and of no matter in it.
    expect(emailsIn(workspaces)).not.toContain(`${ids.userAdmin}@test.local`);
    expect(
      workspaces.some((workspace) =>
        workspace.members.some((member) => member.userId === ids.userAdmin),
      ),
    ).toBe(false);
  });

  test("another organization's matters and members stay out of the payload", async () => {
    const workspaces = await listWorkspacesAs({
      organizationId: ids.orgA,
      userId: ids.userA1,
      workspaceIds: [ids.wsA1, ids.wsA2],
    });

    expect(workspaces.map((workspace) => workspace.id)).not.toContain(ids.wsB1);
    expect(emailsIn(workspaces)).not.toContain(`${ids.userB1}@test.local`);
  });

  test("the other tenant sees its own matter with its own members", async () => {
    const workspaces = await listWorkspacesAs({
      organizationId: ids.orgB,
      userId: ids.userB1,
      workspaceIds: [ids.wsB1],
    });

    expect(workspaces.map((workspace) => workspace.id)).toEqual([ids.wsB1]);
    const memberEmails = emailsIn(workspaces);
    expect(memberEmails).toHaveLength(2);
    expect(memberEmails).toEqual(
      expect.arrayContaining([
        `${ids.userA1}@test.local`,
        `${ids.userB1}@test.local`,
      ]),
    );
  });
});
