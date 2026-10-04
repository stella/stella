import { Value } from "@sinclair/typebox/value";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { inArray } from "drizzle-orm";

import { member, user } from "@/api/db/auth-schema";
import { workspaceMembers } from "@/api/db/schema";
import { createMembershipSafeDb } from "@/api/db/scoped";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import {
  mintAuthProviderId,
  mintAuthProviderIdValue,
} from "@/api/tests/helpers/auth-provider-id";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

import listWorkspaceMemberPreviews from "./list";

setDefaultTimeout(120_000);

let testDb: TestDatabase;
let ids: TestIds;
const seededUserIds: SafeId<"user">[] = [];
const seededOrganizationMemberIds: string[] = [];
const seededWorkspaceMemberIds: SafeId<"workspaceMember">[] = [];

type WorkspaceMemberPreviewResponse = Extract<
  Awaited<ReturnType<typeof listWorkspaceMemberPreviews.handler>>,
  { previews: unknown[] }
>;
type Preview = WorkspaceMemberPreviewResponse["previews"][number];

beforeAll(async () => {
  const fixture = await getRlsFixture();
  testDb = fixture.testDb;
  ids = fixture.ids;
});

afterEach(async () => {
  if (seededWorkspaceMemberIds.length > 0) {
    await testDb
      .delete(workspaceMembers)
      .where(inArray(workspaceMembers.id, seededWorkspaceMemberIds));
    seededWorkspaceMemberIds.length = 0;
  }
  if (seededOrganizationMemberIds.length > 0) {
    await testDb
      .delete(member)
      .where(inArray(member.id, seededOrganizationMemberIds));
    seededOrganizationMemberIds.length = 0;
  }
  if (seededUserIds.length > 0) {
    await testDb.delete(user).where(inArray(user.id, seededUserIds));
    seededUserIds.length = 0;
  }
});

afterAll(async () => {
  await releaseRlsFixture();
});

const listPreviewsAs = async ({
  organizationId,
  userId,
  workspaceIds,
}: {
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  workspaceIds: SafeId<"workspace">[];
}): Promise<Preview[]> => {
  const result = await listWorkspaceMemberPreviews.handler(
    asTestRaw<Parameters<typeof listWorkspaceMemberPreviews.handler>[0]>({
      memberRole: sessionMemberRole("member"),
      safeDb: createMembershipSafeDb(testDb, {
        organizationId,
        serverValidatedWorkspaceIds: [],
        userId,
      }),
      session: { activeOrganizationId: organizationId },
      user: { id: userId },
      query: { workspaceIds },
    }),
  );
  return asTestRaw<WorkspaceMemberPreviewResponse>(result).previews;
};

const seedOrgMember = (index: number) => {
  const userId = mintAuthProviderId<"user">();
  const memberId = mintAuthProviderIdValue();
  seededUserIds.push(userId);
  seededOrganizationMemberIds.push(memberId);
  return {
    user: {
      id: userId,
      name: `Preview user ${index}`,
      email: `${userId}@test.local`,
    },
    member: {
      id: memberId,
      organizationId: ids.orgA,
      userId,
      role: "member",
      createdAt: new Date(),
    },
  };
};

describe("workspace member previews", () => {
  test("returns at most four organization members and counts the full accessible matter team", async () => {
    const extraMembers = Array.from({ length: 4 }, (_, index) =>
      seedOrgMember(index + 1),
    );
    const workspaceMemberRows = extraMembers.map(({ user: seededUser }) => ({
      id: createSafeId<"workspaceMember">(),
      workspaceId: ids.wsA1,
      userId: seededUser.id,
    }));
    seededWorkspaceMemberIds.push(...workspaceMemberRows.map(({ id }) => id));

    await testDb
      .insert(user)
      .values(extraMembers.map(({ user: seededUser }) => seededUser));
    await testDb
      .insert(member)
      .values(extraMembers.map(({ member: seededMember }) => seededMember));
    await testDb.insert(workspaceMembers).values(workspaceMemberRows);

    const [preview] = await listPreviewsAs({
      organizationId: ids.orgA,
      userId: ids.userA1,
      workspaceIds: [ids.wsA1],
    });

    expect(preview).toMatchObject({ workspaceId: ids.wsA1, total: 5 });
    expect(preview?.members).toHaveLength(4);
    expect(preview?.members.map(({ userId }) => userId)).toContain(ids.userA1);
  });

  test("excludes same-organization matters the caller cannot access and other-organization matters", async () => {
    const sameOrganization = await listPreviewsAs({
      organizationId: ids.orgA,
      userId: ids.userA2,
      workspaceIds: [ids.wsA1],
    });
    const otherOrganization = await listPreviewsAs({
      organizationId: ids.orgA,
      userId: ids.userA1,
      workspaceIds: [ids.wsB1],
    });

    expect(sameOrganization).toEqual([]);
    expect(otherOrganization).toEqual([]);
  });

  test("validates the batch cap and safe workspace identifiers at the query boundary", () => {
    const querySchema = listWorkspaceMemberPreviews.config.query;
    const workspaceIds = Array.from({ length: 11 }, () =>
      createSafeId<"workspace">(),
    );

    expect(
      Value.Check(querySchema, { workspaceIds: workspaceIds.slice(0, 10) }),
    ).toBe(true);
    expect(Value.Check(querySchema, { workspaceIds })).toBe(false);
    expect(
      Value.Check(querySchema, { workspaceIds: ["not-a-safe-workspace-id"] }),
    ).toBe(false);
  });
});
