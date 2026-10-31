import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import { member, organization, user } from "@/api/db/auth-schema";
import type { SafeDb, ScopedDb } from "@/api/db/safe-db";
import {
  entities,
  organizationAccessStates,
  taskAssignees,
  workspaceMembers,
} from "@/api/db/schema";
import {
  createMembershipSafeDb,
  createMembershipScopedDb,
} from "@/api/db/scoped";
import type { SafeId } from "@/api/lib/branded-types";
import { createSafeId } from "@/api/lib/branded-types";
import { handleMcpToolCall } from "@/api/mcp/tools";
import type { AuthorizedMcpRequestContext } from "@/api/mcp/write-tool-authority";
import {
  mintAuthProviderId,
  mintAuthProviderIdValue,
} from "@/api/tests/helpers/auth-provider-id";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { getTestDb, releaseTestDb } from "@/api/tests/security/test-utils";
import type { TestDatabase } from "@/api/tests/security/test-utils";

const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";
let testDb: TestDatabase;

beforeAll(async () => {
  if (enabled) {
    testDb = await getTestDb();
  }
});

afterAll(async () => {
  if (enabled) {
    await releaseTestDb();
  }
});

const responsePayload = (
  result: Awaited<ReturnType<typeof handleMcpToolCall>>,
): Record<string, unknown> => {
  const content = result.content.at(0);
  if (content?.type !== "text") {
    throw new Error("Expected a text MCP response");
  }
  const payload: unknown = JSON.parse(content.text);
  if (payload === null || typeof payload !== "object") {
    throw new Error("Expected an object MCP response");
  }
  return Object.fromEntries(Object.entries(payload));
};

describe.skipIf(!enabled)("save_task assignee updates", () => {
  test("persists assignees resolved by user id and email and rejects an unknown member without mutation", async () => {
    const organizationId = mintAuthProviderId<"organization">();
    const ownerId = mintAuthProviderId<"user">();
    const firstAssigneeId = mintAuthProviderId<"user">();
    const secondAssigneeId = mintAuthProviderId<"user">();
    const secondAssigneeEmail = `${secondAssigneeId}@test.local`;

    await testDb.insert(user).values([
      { id: ownerId, name: "Owner", email: `${ownerId}@test.local` },
      {
        id: firstAssigneeId,
        name: "First assignee",
        email: `${firstAssigneeId}@test.local`,
      },
      {
        id: secondAssigneeId,
        name: "Second assignee",
        email: secondAssigneeEmail,
      },
    ]);
    await testDb.insert(organization).values({
      id: organizationId,
      name: "Task assignment test",
      slug: `task-assignment-${organizationId}`,
      createdAt: new Date(),
    });
    await testDb.insert(member).values({
      id: mintAuthProviderIdValue(),
      organizationId,
      userId: ownerId,
      role: "owner",
      createdAt: new Date(),
    });
    await testDb.insert(organizationAccessStates).values({
      organizationId,
      state: "self_managed_keys",
    });
    await testDb.insert(member).values(
      [firstAssigneeId, secondAssigneeId].map((userId) => ({
        id: mintAuthProviderIdValue(),
        organizationId,
        userId,
        role: "member" as const,
        createdAt: new Date(),
      })),
    );

    const identity = {
      organizationId,
      serverValidatedWorkspaceIds: [],
      userId: ownerId,
    };
    const scopedDb = asTestRaw<ScopedDb>(
      createMembershipScopedDb(testDb, identity),
    );
    const safeDb = asTestRaw<SafeDb>(createMembershipSafeDb(testDb, identity));
    const contextFor = (
      workspaceIds: readonly SafeId<"workspace">[],
    ): AuthorizedMcpRequestContext =>
      asTestRaw<AuthorizedMcpRequestContext>({
        accessibleWorkspaceIds: workspaceIds,
        accessibleWorkspaceIdSet: new Set(workspaceIds),
        accessibleWorkspaceStatusById: new Map(
          workspaceIds.map((id) => [id, "active" as const]),
        ),
        accessibleWorkspaces: [],
        grantedScopes: ["stella:matters_write"],
        memberRole: "owner",
        organizationId,
        recordAuditEvent: async () => undefined,
        safeDb,
        scopedDb,
        userId: ownerId,
        userEmail: `${ownerId}@test.local`,
      });

    const matterResult = await handleMcpToolCall({
      toolName: "save_matter",
      args: { name: "Assignment matter" },
      context: contextFor([]),
    });
    expect(matterResult.isError).toBeUndefined();
    const matterId = responsePayload(matterResult)["matterId"];
    if (typeof matterId !== "string") {
      throw new TypeError("Expected a matter id");
    }
    const workspaceId = asTestRaw<SafeId<"workspace">>(matterId);
    await testDb.insert(workspaceMembers).values(
      [firstAssigneeId, secondAssigneeId].map((userId) => ({
        id: createSafeId<"workspaceMember">(),
        workspaceId,
        userId,
      })),
    );

    const context = contextFor([workspaceId]);
    const taskResult = await handleMcpToolCall({
      toolName: "save_task",
      args: { matter_id: workspaceId, name: "Assign me" },
      context,
    });
    expect(taskResult.isError).toBeUndefined();
    const taskId = responsePayload(taskResult)["taskId"];
    if (typeof taskId !== "string") {
      throw new TypeError("Expected a task id");
    }
    const taskEntityId = asTestRaw<SafeId<"entity">>(taskId);

    const assignById = await handleMcpToolCall({
      toolName: "save_task",
      args: { task_id: taskId, assignee: firstAssigneeId },
      context,
    });
    expect(assignById.isError).toBeUndefined();
    expect(
      await testDb
        .select({ userId: taskAssignees.userId })
        .from(taskAssignees)
        .where(eq(taskAssignees.entityId, taskEntityId)),
    ).toEqual([{ userId: firstAssigneeId }]);

    const persistedBeforeUnknown = await testDb
      .select({ userId: taskAssignees.userId })
      .from(taskAssignees)
      .where(eq(taskAssignees.entityId, taskEntityId))
      .orderBy(taskAssignees.userId);
    expect(new Set(persistedBeforeUnknown.map(({ userId }) => userId))).toEqual(
      new Set([firstAssigneeId]),
    );

    const unknown = await handleMcpToolCall({
      toolName: "save_task",
      args: {
        task_id: taskId,
        name: "Must not persist",
        status: "done",
        assignee: "unknown-member@test.local",
      },
      context,
    });
    expect(unknown.isError).toBe(true);
    expect(responsePayload(unknown)).toMatchObject({
      error: {
        code: "not_found",
        message: "Organization member not found for assignee",
      },
    });
    expect(
      await testDb
        .select({ userId: taskAssignees.userId })
        .from(taskAssignees)
        .where(eq(taskAssignees.entityId, taskEntityId))
        .orderBy(taskAssignees.userId),
    ).toEqual(persistedBeforeUnknown);
    expect(
      await testDb
        .select({ name: entities.name, status: entities.status })
        .from(entities)
        .where(eq(entities.id, taskEntityId)),
    ).toEqual([{ name: "Assign me", status: "open" }]);

    const assignByEmail = await handleMcpToolCall({
      toolName: "save_task",
      args: {
        task_id: taskId,
        name: "Assigned and renamed",
        assignee: secondAssigneeEmail,
      },
      context,
    });
    expect(assignByEmail.isError).toBeUndefined();
    expect(
      await testDb
        .select({ name: entities.name, status: entities.status })
        .from(entities)
        .where(eq(entities.id, taskEntityId)),
    ).toEqual([{ name: "Assigned and renamed", status: "open" }]);
    expect(
      new Set(
        (
          await testDb
            .select({ userId: taskAssignees.userId })
            .from(taskAssignees)
            .where(eq(taskAssignees.entityId, taskEntityId))
        ).map(({ userId }) => userId),
      ),
    ).toEqual(new Set([firstAssigneeId, secondAssigneeId]));
  });
});
