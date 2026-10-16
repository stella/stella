import { Result } from "better-result";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { eq, inArray } from "drizzle-orm";

import type { MatterVisibility } from "@stll/api-contract";
import { MATTER_STEWARD_HANDOVER_REQUIRED_CODE } from "@stll/api-contract/matter-visibility";

import type { Transaction } from "@/api/db/root";
import type { SafeDb } from "@/api/db/safe-db";
import { workspaceMembers, workspaces } from "@/api/db/schema";
import { createSafeDb } from "@/api/db/scoped";
import { updateWorkspaceHandler } from "@/api/handlers/workspaces/update";
import type { WorkspaceUpdateActor } from "@/api/handlers/workspaces/update";
import type { AuditEvent, AuditRecorder } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { lockMatterStewardship } from "@/api/lib/db/aggregate-lock";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import {
  leadsAssignedOnlyMatter,
  restoreMatterStewards,
} from "@/api/lib/workspaces/visibility";
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

afterEach(async () => {
  if (createdWorkspaceIds.length > 0) {
    await testDb
      .delete(workspaces)
      .where(inArray(workspaces.id, createdWorkspaceIds));
  }
  createdWorkspaceIds.length = 0;
});

afterAll(async () => {
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
  visibility: MatterVisibility;
  members: readonly SafeId<"user">[];
}): Promise<SafeId<"workspace">> => {
  const workspaceId = createSafeId<"workspace">();
  await testDb.transaction(async (tx) => {
    await lockMatterStewardship({
      tx: asTestRaw<Transaction>(tx),
      requests: [
        {
          organizationId: ids.orgA,
          workspaceIds: [workspaceId],
          userIds: members,
        },
      ],
      mode: "update",
    });
    await tx.insert(workspaces).values({
      id: workspaceId,
      organizationId: ids.orgA,
      clientId: null,
      leadUserId: members.includes(ids.userA1) ? ids.userA1 : null,
      name: `Visibility ${workspaceId}`,
      reference: `VIS-${workspaceId}`,
      visibility,
    });
    if (members.length > 0) {
      await tx.insert(workspaceMembers).values(
        members.map((userId) => ({
          id: createSafeId<"workspaceMember">(),
          workspaceId,
          userId,
        })),
      );
    }
  });
  createdWorkspaceIds.push(workspaceId);
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

const readLead = async (workspaceId: SafeId<"workspace">) =>
  (
    await testDb
      .select({ leadUserId: workspaces.leadUserId })
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId))
  ).at(0)?.leadUserId;

const LEAD = () => ({ userId: ids.userA1, managesOrganizationMatters: false });
const NON_LEAD_MEMBER = () => ({
  userId: ids.userA2,
  managesOrganizationMatters: false,
});
const ADMIN = () => ({
  userId: ids.userAdmin,
  managesOrganizationMatters: true,
});

describe("changing a matter's visibility", () => {
  test.each([
    ["assigned_only", "admins_and_assigned"],
    ["assigned_only", "all_members"],
    ["admins_and_assigned", "all_members"],
  ] as const)(
    "the matter lead may widen %s to %s, and the change is audited as widening",
    async (from, to) => {
      const workspaceId = await createMatter({
        visibility: from,
        members: [ids.userA1, ids.userA2],
      });

      const { result, events } = await changeVisibility({
        actor: LEAD(),
        workspaceId,
        body: { visibility: to },
      });

      expect(Result.isOk(result)).toBe(true);
      expect(await readVisibility(workspaceId)).toBe(to);
      expect(events).toEqual([
        expect.objectContaining({
          resourceId: workspaceId,
          changes: { visibility: { old: from, new: to } },
          metadata: { visibilityChange: "widened" },
        }),
      ]);
    },
  );

  test("a member who does not lead the matter cannot change it, even by naming themselves lead in the same request", async () => {
    const workspaceId = await createMatter({
      visibility: "assigned_only",
      members: [ids.userA1, ids.userA2],
    });

    for (const body of [
      { visibility: "all_members" as const },
      { visibility: "admins_and_assigned" as const, leadUserId: ids.userA2 },
    ]) {
      const { result, events } = await changeVisibility({
        actor: NON_LEAD_MEMBER(),
        workspaceId,
        body,
      });
      expect(statusOf(result)).toBe(403);
      expect(events).toEqual([]);
    }
    expect(await readVisibility(workspaceId)).toBe("assigned_only");
    expect(await readLead(workspaceId)).toBe(ids.userA1);
  });

  test("an organization admin may narrow an all-members matter, and the change is audited as narrowing", async () => {
    const workspaceId = await createMatter({
      visibility: "all_members",
      members: [ids.userA1],
    });

    const { result, events } = await changeVisibility({
      actor: ADMIN(),
      workspaceId,
      body: { visibility: "admins_and_assigned" },
    });

    expect(Result.isOk(result)).toBe(true);
    expect(await readVisibility(workspaceId)).toBe("admins_and_assigned");
    expect(events.at(0)).toMatchObject({
      changes: {
        visibility: { old: "all_members", new: "admins_and_assigned" },
      },
      metadata: { visibilityChange: "narrowed" },
    });
  });

  test("a matter with no members cannot be made assigned-only", async () => {
    const workspaceId = await createMatter({
      visibility: "admins_and_assigned",
      members: [],
    });

    const { result } = await changeVisibility({
      actor: ADMIN(),
      workspaceId,
      body: { visibility: "assigned_only" },
    });

    expect(statusOf(result)).toBe(400);
    expect(await readVisibility(workspaceId)).toBe("admins_and_assigned");
  });

  test("the lead cannot clear the lead of an assigned-only matter", async () => {
    const workspaceId = await createMatter({
      visibility: "assigned_only",
      members: [ids.userA1, ids.userA2],
    });

    const { result, events } = await changeVisibility({
      actor: LEAD(),
      workspaceId,
      body: { leadUserId: null },
    });

    expect(statusOf(result)).toBe(400);
    expect(events).toEqual([]);
    expect(await readLead(workspaceId)).toBe(ids.userA1);
  });

  test("a matter without a lead cannot be made assigned-only, even with members", async () => {
    const workspaceId = await createMatter({
      visibility: "admins_and_assigned",
      members: [ids.userA2],
    });

    const { result } = await changeVisibility({
      actor: ADMIN(),
      workspaceId,
      body: { visibility: "assigned_only" },
    });

    expect(statusOf(result)).toBe(400);
    expect(await readVisibility(workspaceId)).toBe("admins_and_assigned");

    // Naming an assigned member lead in the same change satisfies it.
    const named = await changeVisibility({
      actor: ADMIN(),
      workspaceId,
      body: { visibility: "assigned_only", leadUserId: ids.userA2 },
    });
    expect(Result.isOk(named.result)).toBe(true);
    expect(await readVisibility(workspaceId)).toBe("assigned_only");
  });

  test("restating the current visibility is not a change and needs no permission", async () => {
    const workspaceId = await createMatter({
      visibility: "assigned_only",
      members: [ids.userA1, ids.userA2],
    });

    const { result, events } = await changeVisibility({
      actor: NON_LEAD_MEMBER(),
      workspaceId,
      body: { visibility: "assigned_only", name: "Renamed" },
    });

    expect(Result.isOk(result)).toBe(true);
    expect(events.at(0)?.changes).not.toHaveProperty("visibility");
    expect(events.at(0)?.metadata).toBeUndefined();
  });
});

describe("changing a matter's lead", () => {
  test("a member who does not lead the matter cannot make themselves, or anyone, the lead", async () => {
    const workspaceId = await createMatter({
      visibility: "admins_and_assigned",
      members: [ids.userA1, ids.userA2],
    });

    for (const leadUserId of [ids.userA2, null]) {
      const { result, events } = await changeVisibility({
        actor: NON_LEAD_MEMBER(),
        workspaceId,
        body: { leadUserId },
      });
      expect(statusOf(result)).toBe(403);
      expect(events).toEqual([]);
    }
    expect(await readLead(workspaceId)).toBe(ids.userA1);
  });

  test("the current lead may hand the matter to another member", async () => {
    const workspaceId = await createMatter({
      visibility: "admins_and_assigned",
      members: [ids.userA1, ids.userA2],
    });

    const { result } = await changeVisibility({
      actor: LEAD(),
      workspaceId,
      body: { leadUserId: ids.userA2 },
    });

    expect(Result.isOk(result)).toBe(true);
    expect(await readLead(workspaceId)).toBe(ids.userA2);
  });

  test("an organization admin may set the lead of a matter they do not lead", async () => {
    const workspaceId = await createMatter({
      visibility: "admins_and_assigned",
      members: [ids.userA1, ids.userA2],
    });

    const { result } = await changeVisibility({
      actor: ADMIN(),
      workspaceId,
      body: { leadUserId: ids.userA2 },
    });

    expect(Result.isOk(result)).toBe(true);
    expect(await readLead(workspaceId)).toBe(ids.userA2);
  });
});

describe("keeping a steward when a lead leaves", () => {
  // Assignment removal, organization offboarding and account deletion restore
  // the steward before removing the departing lead through this one call.
  // The caller's recorder carries the actor (the removing member, the
  // offboarding run or the account-deletion run); the repair supplies the
  // events it records.
  const restore = async (
    workspaceId: SafeId<"workspace">,
    departingUserId: SafeId<"user">,
  ): Promise<AuditEvent[]> => {
    const events: AuditEvent[] = [];
    const recordAuditEvent: AuditRecorder = (_tx, event) => {
      events.push(...(Array.isArray(event) ? event : [event]));
    };
    await testDb.transaction(async (tx) => {
      await restoreMatterStewards(asTestRaw<Transaction>(tx), {
        workspaceIds: [workspaceId],
        organizationId: ids.orgA,
        departingUserId,
        actorUserId: departingUserId,
        recordAuditEvent,
      });
    });
    return events;
  };

  test("the earliest remaining assigned internal member becomes lead; the departing user is never chosen", async () => {
    const workspaceId = await createMatter({
      visibility: "assigned_only",
      members: [ids.userA1, ids.userA2],
    });

    // The departing lead's rows may still exist when the repair runs.
    const events = await restore(workspaceId, ids.userA1);

    expect(await readLead(workspaceId)).toBe(ids.userA2);
    expect(await readVisibility(workspaceId)).toBe("assigned_only");
    expect(events).toEqual([
      {
        action: "update",
        resourceType: "workspace",
        resourceId: workspaceId,
        workspaceId,
        changes: { leadUserId: { old: ids.userA1, new: ids.userA2 } },
        metadata: { cause: "matter_steward_restored" },
      },
    ]);
  });

  test("with nobody left to lead, removal is refused without widening", async () => {
    const workspaceId = await createMatter({
      visibility: "assigned_only",
      members: [ids.userA1],
    });
    const result = await Result.tryPromise({
      try: async () => await restore(workspaceId, ids.userA1),
      catch: (error) => error,
    });
    expect(result).toMatchObject({
      status: "error",
      error: { status: 409, code: MATTER_STEWARD_HANDOVER_REQUIRED_CODE },
    });
    expect(await readLead(workspaceId)).toBe(ids.userA1);
    expect(await readVisibility(workspaceId)).toBe("assigned_only");
  });

  test("a matter whose lead stays usable is left alone", async () => {
    const workspaceId = await createMatter({
      visibility: "assigned_only",
      members: [ids.userA1, ids.userA2],
    });

    const events = await restore(workspaceId, ids.userA2);

    expect(await readLead(workspaceId)).toBe(ids.userA1);
    expect(await readVisibility(workspaceId)).toBe("assigned_only");
    expect(events).toEqual([]);
  });

  test("a member who leads an assigned-only matter is found before their role turns external", async () => {
    const assignedOnly = await createMatter({
      visibility: "assigned_only",
      members: [ids.userA1, ids.userA2],
    });
    const led = async (userId: SafeId<"user">) =>
      await leadsAssignedOnlyMatter(asTestRaw<Transaction>(testDb), {
        organizationId: ids.orgA,
        userId,
      });

    expect(await led(ids.userA1)).toBe(true);
    await testDb
      .update(workspaces)
      .set({ visibility: "admins_and_assigned" })
      .where(eq(workspaces.id, assignedOnly));
    expect(await led(ids.userA1)).toBe(false);
  });
});
