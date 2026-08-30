import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";

import { createSafeDb } from "@/api/db/scoped";
import type { SafeId } from "@/api/lib/branded-types";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

import readWorkspaces from "./list";

// Evidence for the `no-unscoped-user-query` waiver on the `user` import: every
// identity in the payload arrives through `workspace_members` rows of the
// organization's own matters. `user` is readable under RLS for any member of
// the active organization (`auth_user_select`), so organization membership
// alone is not what keeps a colleague out of a matter's member list — the join
// is.

setDefaultTimeout(120_000);

let testDb: TestDatabase;
let ids: TestIds;

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
});

afterAll(async () => {
  await releaseRlsFixture();
});

const listWorkspacesAs = async ({
  organizationId,
  userId,
  workspaceIds,
}: {
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  workspaceIds: SafeId<"workspace">[];
}): Promise<ListedWorkspace[]> => {
  const result = await readWorkspaces.handler(
    asTestRaw<Parameters<typeof readWorkspaces.handler>[0]>({
      memberRole: { role: "owner" },
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
