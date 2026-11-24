import { panic, Result } from "better-result";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import {
  MATTER_STEWARD_HANDOVER_REQUIRED_CODE,
  MATTER_VISIBILITY_WIDENING_UNCONFIRMED_CODE,
} from "@stll/api-contract/matter-visibility";
import type { MatterVisibility } from "@stll/api-contract/matter-visibility";

import type { SafeDb } from "@/api/db/safe-db";
import { workspaceMembers, workspaces } from "@/api/db/schema";
import { createSafeDb } from "@/api/db/scoped";
import type { AuditEvent } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  createTestIds,
  setupRlsTestData,
} from "@/api/tests/security/rls-helpers";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import { getTestDb, releaseTestDb } from "@/api/tests/security/test-utils";
import type { TestDatabase } from "@/api/tests/security/test-utils";

import { updateWorkspaceHandler } from "./update";
import type { UpdateWorkspaceHandlerProps } from "./update";

let testDb: TestDatabase;
let ids: TestIds;

// timeout: booting the full PGlite schema can exceed the default hook budget.
beforeAll(async () => {
  testDb = await getTestDb();
  ids = createTestIds();
  await setupRlsTestData(testDb, ids);
}, 60_000);

afterAll(async () => {
  await releaseTestDb();
});

type MatterOptions = {
  visibility: MatterVisibility | null;
  client: boolean;
  assigned: readonly SafeId<"user">[];
  leadUserId?: SafeId<"user">;
};

const createMatter = async ({
  visibility,
  client,
  assigned,
  leadUserId,
}: MatterOptions) => {
  const workspaceId = createSafeId<"workspace">();
  // One transaction: an assigned-only matter needs its internal member by
  // commit.
  await testDb.transaction(async (tx) => {
    await tx.insert(workspaces).values({
      id: workspaceId,
      organizationId: ids.orgA,
      clientId: client ? ids.contactA : null,
      name: "Visibility matter",
      reference: `VIS-${workspaceId}`,
      visibility,
      ...(leadUserId === undefined ? {} : { leadUserId }),
    });
    if (assigned.length > 0) {
      await tx
        .insert(workspaceMembers)
        .values(assigned.map((userId) => ({ workspaceId, userId })));
    }
  });
  return workspaceId;
};

const storedVisibility = async (workspaceId: SafeId<"workspace">) =>
  (
    await testDb
      .select({
        visibility: workspaces.visibility,
        clientId: workspaces.clientId,
      })
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId))
  ).at(0) ?? panic("matter row");

type UpdateCall = {
  workspaceId: SafeId<"workspace">;
  userId: SafeId<"user">;
  /** The role the request's credential speaks for. */
  credentialRole: "owner" | "admin" | "member";
  body: UpdateWorkspaceHandlerProps["body"];
};

const update = async ({
  workspaceId,
  userId,
  credentialRole,
  body,
}: UpdateCall) => {
  const events: AuditEvent[] = [];
  const result = await Result.gen(() =>
    updateWorkspaceHandler({
      actor: { userId, authority: sessionMemberRole(credentialRole) },
      safeDb: asTestRaw<SafeDb>(
        createSafeDb(testDb, [workspaceId], ids.orgA, userId),
      ),
      organizationId: ids.orgA,
      workspaceId,
      recordAuditEvent: async (_tx, event) => {
        events.push(...(Array.isArray(event) ? event : [event]));
      },
      body,
    }),
  );
  return { result, events };
};

const refusalOf = (result: Awaited<ReturnType<typeof update>>["result"]) =>
  result.isErr() ? result.error : panic("expected a refusal");

describe("matter visibility changes", () => {
  test("widening needs a confirmation; without one nothing is written or audited", async () => {
    const workspaceId = await createMatter({
      visibility: "assigned_only",
      client: false,
      assigned: [ids.userAdmin],
    });

    const unconfirmed = await update({
      workspaceId,
      userId: ids.userAdmin,
      credentialRole: "owner",
      body: { visibility: "all_members" },
    });
    expect(refusalOf(unconfirmed.result)).toMatchObject({
      status: 409,
      code: MATTER_VISIBILITY_WIDENING_UNCONFIRMED_CODE,
    });
    expect(unconfirmed.events).toEqual([]);
    expect((await storedVisibility(workspaceId)).visibility).toBe(
      "assigned_only",
    );

    const confirmed = await update({
      workspaceId,
      userId: ids.userAdmin,
      credentialRole: "owner",
      body: { visibility: "all_members", confirmWidening: true },
    });
    expect(confirmed.result.isOk()).toBe(true);
    expect((await storedVisibility(workspaceId)).visibility).toBe(
      "all_members",
    );
    expect(confirmed.events).toEqual([
      expect.objectContaining({
        changes: { visibility: { old: "assigned_only", new: "all_members" } },
        metadata: { visibilityChange: "widened" },
      }),
    ]);
  });

  test("narrowing needs no confirmation and is audited as narrowed", async () => {
    const workspaceId = await createMatter({
      visibility: "all_members",
      client: true,
      assigned: [ids.userA1],
    });
    const narrowed = await update({
      workspaceId,
      userId: ids.userAdmin,
      credentialRole: "owner",
      body: { visibility: "admins_and_assigned" },
    });
    expect(narrowed.result.isOk()).toBe(true);
    expect(narrowed.events).toEqual([
      expect.objectContaining({
        changes: {
          visibility: { old: "all_members", new: "admins_and_assigned" },
        },
        metadata: { visibilityChange: "narrowed" },
      }),
    ]);
  });

  test("narrowing to assigned only without an assigned internal member is refused", async () => {
    const workspaceId = await createMatter({
      visibility: null,
      client: true,
      assigned: [],
    });
    const refused = await update({
      workspaceId,
      userId: ids.userAdmin,
      credentialRole: "owner",
      body: { visibility: "assigned_only" },
    });
    expect(refusalOf(refused.result)).toMatchObject({
      status: 409,
      code: MATTER_STEWARD_HANDOVER_REQUIRED_CODE,
    });
    expect(await storedVisibility(workspaceId)).toEqual({
      visibility: null,
      clientId: ids.contactA,
    });
  });

  test("only the matter lead or an owner or admin may change the visibility", async () => {
    const workspaceId = await createMatter({
      visibility: "admins_and_assigned",
      client: true,
      assigned: [ids.userA1, ids.userA2],
      leadUserId: ids.userA2,
    });
    const notLead = await update({
      workspaceId,
      userId: ids.userA1,
      credentialRole: "member",
      body: { visibility: "assigned_only" },
    });
    expect(refusalOf(notLead.result)).toMatchObject({ status: 403 });

    // A credential that claims organization management does not outrank the
    // member's current role.
    const claimedAdmin = await update({
      workspaceId,
      userId: ids.userA1,
      credentialRole: "admin",
      body: { visibility: "assigned_only" },
    });
    expect(refusalOf(claimedAdmin.result)).toMatchObject({ status: 403 });

    const lead = await update({
      workspaceId,
      userId: ids.userA2,
      credentialRole: "member",
      body: { visibility: "assigned_only" },
    });
    expect(lead.result.isOk()).toBe(true);
    expect((await storedVisibility(workspaceId)).visibility).toBe(
      "assigned_only",
    );
  });

  test("a member cannot name themselves lead to take over who can see the matter", async () => {
    const workspaceId = await createMatter({
      visibility: "admins_and_assigned",
      client: true,
      assigned: [ids.userA1],
    });
    const selfAppointed = await update({
      workspaceId,
      userId: ids.userA1,
      credentialRole: "member",
      body: { leadUserId: ids.userA1 },
    });
    expect(refusalOf(selfAppointed.result)).toMatchObject({ status: 403 });
    const widened = await update({
      workspaceId,
      userId: ids.userA1,
      credentialRole: "member",
      body: { visibility: "all_members", confirmWidening: true },
    });
    expect(refusalOf(widened.result)).toMatchObject({ status: 403 });
    expect((await storedVisibility(workspaceId)).visibility).toBe(
      "admins_and_assigned",
    );

    // An owner may appoint the lead, who may then change the visibility.
    const appointed = await update({
      workspaceId,
      userId: ids.userAdmin,
      credentialRole: "owner",
      body: { leadUserId: ids.userA1 },
    });
    expect(appointed.result.isOk()).toBe(true);
  });

  test("a member who no longer reaches the matter cannot update it through an earlier admission", async () => {
    const workspaceId = await createMatter({
      visibility: "assigned_only",
      client: true,
      assigned: [ids.userA1],
    });
    // The owner was admitted with the matter pinned, but an assigned-only
    // matter does not reach an unassigned owner.
    const stale = await update({
      workspaceId,
      userId: ids.userAdmin,
      credentialRole: "owner",
      body: { name: "Renamed" },
    });
    expect(refusalOf(stale.result)).toMatchObject({ status: 404 });
    expect(stale.events).toEqual([]);
  });

  test("attaching or removing a client never changes who can see the matter", async () => {
    const workspaceId = await createMatter({
      visibility: null,
      client: false,
      assigned: [ids.userA1],
    });
    const attached = await update({
      workspaceId,
      userId: ids.userA1,
      credentialRole: "member",
      body: { clientId: ids.contactA },
    });
    expect(attached.result.isOk()).toBe(true);
    // The matter had no client, so it was assigned-only; it stays that way.
    expect(await storedVisibility(workspaceId)).toEqual({
      visibility: "assigned_only",
      clientId: ids.contactA,
    });
  });
});
