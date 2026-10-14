import { Result } from "better-result";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { eq, inArray } from "drizzle-orm";

import type { SafeDb } from "@/api/db/safe-db";
import { workspaceMembers, workspaces } from "@/api/db/schema";
import { createSafeDb } from "@/api/db/scoped";
import { updateWorkspaceHandler } from "@/api/handlers/workspaces/update";
import type { WorkspaceUpdateActor } from "@/api/handlers/workspaces/update";
import type { AuditEvent, AuditRecorder } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

setDefaultTimeout(120_000);

let testDb: TestDatabase;
let ids: TestIds;
const createdWorkspaceIds: SafeId<"workspace">[] = [];

beforeAll(async () => {
  const fixture = await getRlsFixture();
  testDb = fixture.testDb;
  ids = fixture.ids;
});

afterAll(async () => {
  if (createdWorkspaceIds.length > 0) {
    await testDb
      .delete(workspaces)
      .where(inArray(workspaces.id, createdWorkspaceIds));
  }
  await releaseRlsFixture();
});

/**
 * A matter in organization A led by userA1, with userA1 and userA2 as members.
 * The fixture's userAdmin is the organization's owner and is not a member.
 */
const createMatter = async ({
  visibility,
  members,
}: {
  visibility: "organization" | "private";
  members: readonly SafeId<"user">[];
}): Promise<SafeId<"workspace">> => {
  const workspaceId = createSafeId<"workspace">();
  await testDb.insert(workspaces).values({
    id: workspaceId,
    organizationId: ids.orgA,
    clientId: null,
    leadUserId: members.includes(ids.userA1) ? ids.userA1 : null,
    name: `Visibility ${workspaceId}`,
    reference: `VIS-${workspaceId}`,
    visibility,
  });
  createdWorkspaceIds.push(workspaceId);
  if (members.length > 0) {
    await testDb.insert(workspaceMembers).values(
      members.map((userId) => ({
        id: createSafeId<"workspaceMember">(),
        workspaceId,
        userId,
      })),
    );
  }
  return workspaceId;
};

const readVisibility = async (workspaceId: SafeId<"workspace">) =>
  (
    await testDb
      .select({ visibility: workspaces.visibility })
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId))
  ).at(0)?.visibility;

const changeVisibility = async ({
  actor,
  workspaceId,
  body,
}: {
  actor: WorkspaceUpdateActor;
  workspaceId: SafeId<"workspace">;
  body: Parameters<typeof updateWorkspaceHandler>[0]["body"];
}) => {
  const events: AuditEvent[] = [];
  const recordAuditEvent: AuditRecorder = (_tx, event) => {
    events.push(...(Array.isArray(event) ? event : [event]));
  };
  // Pinned to the matter: what the request gate resolved before the handler.
  const safeDb = asTestRaw<SafeDb>(
    createSafeDb(testDb, [workspaceId], ids.orgA, actor.userId),
  );
  const result = await Result.gen(() =>
    updateWorkspaceHandler({
      actor,
      userEmail: "member@example.test",
      safeDb,
      organizationId: ids.orgA,
      workspaceId,
      recordAuditEvent,
      body,
    }),
  );
  return { result, events };
};

const statusOf = (result: Result<unknown, unknown>) =>
  Result.isError(result) && HandlerError.is(result.error)
    ? result.error.status
    : null;

describe("changing a matter's visibility", () => {
  test("the matter lead may open a private matter to the organization, and the change is audited", async () => {
    const workspaceId = await createMatter({
      visibility: "private",
      members: [ids.userA1, ids.userA2],
    });

    const { result, events } = await changeVisibility({
      actor: { userId: ids.userA1, managesOrganizationMatters: false },
      workspaceId,
      body: { visibility: "organization" },
    });

    expect(Result.isOk(result)).toBe(true);
    expect(await readVisibility(workspaceId)).toBe("organization");
    expect(events).toEqual([
      expect.objectContaining({
        resourceId: workspaceId,
        changes: {
          visibility: { old: "private", new: "organization" },
        },
        metadata: { visibilityChange: "opened_to_organization" },
      }),
    ]);
  });

  test("a member who does not lead the matter cannot change it, even by naming themselves lead in the same request", async () => {
    const workspaceId = await createMatter({
      visibility: "private",
      members: [ids.userA1, ids.userA2],
    });

    for (const body of [
      { visibility: "organization" as const },
      { visibility: "organization" as const, leadUserId: ids.userA2 },
    ]) {
      const { result, events } = await changeVisibility({
        actor: { userId: ids.userA2, managesOrganizationMatters: false },
        workspaceId,
        body,
      });
      expect(statusOf(result)).toBe(403);
      expect(events).toEqual([]);
    }
    expect(await readVisibility(workspaceId)).toBe("private");
  });

  test("an organization admin may make an organization matter private", async () => {
    const workspaceId = await createMatter({
      visibility: "organization",
      members: [ids.userA1],
    });

    const { result, events } = await changeVisibility({
      actor: { userId: ids.userAdmin, managesOrganizationMatters: true },
      workspaceId,
      body: { visibility: "private" },
    });

    expect(Result.isOk(result)).toBe(true);
    expect(await readVisibility(workspaceId)).toBe("private");
    expect(events.at(0)).toMatchObject({
      changes: { visibility: { old: "organization", new: "private" } },
      metadata: { visibilityChange: "made_private" },
    });
  });

  test("a matter with no members cannot be made private", async () => {
    const workspaceId = await createMatter({
      visibility: "organization",
      members: [],
    });

    const { result } = await changeVisibility({
      actor: { userId: ids.userAdmin, managesOrganizationMatters: true },
      workspaceId,
      body: { visibility: "private" },
    });

    expect(statusOf(result)).toBe(400);
    expect(await readVisibility(workspaceId)).toBe("organization");
  });

  test("restating the current visibility is not a change and needs no permission", async () => {
    const workspaceId = await createMatter({
      visibility: "private",
      members: [ids.userA1, ids.userA2],
    });

    const { result, events } = await changeVisibility({
      actor: { userId: ids.userA2, managesOrganizationMatters: false },
      workspaceId,
      body: { visibility: "private", name: "Renamed" },
    });

    expect(Result.isOk(result)).toBe(true);
    expect(events.at(0)?.changes).not.toHaveProperty("visibility");
    expect(events.at(0)?.metadata).toBeUndefined();
  });
});
