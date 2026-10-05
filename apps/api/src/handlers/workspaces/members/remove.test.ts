import { Result } from "better-result";
import { describe, expect, mock, test } from "bun:test";
import { getTableName } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";

import {
  auditLogs,
  correspondence,
  desktopEditSessions,
  desktopEditHandoffs,
  timeEntries,
  workspaceMembers,
  workspaces,
} from "@/api/db/schema";
import { ORG_AI_CONFIG_STATUS } from "@/api/lib/ai-config-loader-core";
import { createAuditRecorder } from "@/api/lib/audit-log";
import { toSafeId } from "@/api/lib/branded-types";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  createScopedDbMock,
  createSelectQueryMock,
} from "@/api/tests/scoped-db-mock";

import {
  createRemoveWorkspaceMember,
  removeWorkspaceMemberHandler,
} from "./remove";

const revokeWorkspaceSseAccessMock = mock(async () => undefined);
const removeWorkspaceMember = createRemoveWorkspaceMember({
  broadcastSessionEvent: () => undefined,
  broadcastWorkspaceResourceSetUpdated: () => undefined,
  closeSessionConnections: () => undefined,
  revokeWorkspaceSseAccess: revokeWorkspaceSseAccessMock,
});

type RemoveMemberCtx = Parameters<typeof removeWorkspaceMember.handler>[0];

const createContext = ({
  safeDb,
  scopedDb,
}: {
  safeDb: RemoveMemberCtx["safeDb"];
  scopedDb: RemoveMemberCtx["scopedDb"];
}): RemoveMemberCtx => {
  const recorderBindings = {
    organizationId: toSafeId<"organization">("org_test123"),
    workspaceId: toSafeId<"workspace">("ws_test123"),
    userId: toSafeId<"user">("user_test123"),
    request: new Request(
      "https://api.example.test/v1/workspaces/ws_test123/members",
    ),
    server: null,
  };

  return asTestRaw<RemoveMemberCtx>({
    safeDb,
    scopedDb,
    memberRole: sessionMemberRole("owner"),
    orgAIConfig: null,
    orgAIConfigStatus: ORG_AI_CONFIG_STATUS.ok,
    managedAIResidency: "eu" as const,
    params: { userId: "user_lead" },
    request: recorderBindings.request,
    session: {
      activeOrganizationId: recorderBindings.organizationId,
    },
    user: { id: recorderBindings.userId },
    workspaceId: recorderBindings.workspaceId,
    recordAuditEvent: createAuditRecorder(recorderBindings),
    createAuditRecorder: () => createAuditRecorder(recorderBindings),
  });
};

describe("removeWorkspaceMember", () => {
  test("rejects removal while the member has an active timer", async () => {
    const workspaceId = toSafeId<"workspace">("ws_timer_test");
    const userId = toSafeId<"user">("user_timer_test");
    const actorUserId = toSafeId<"user">("user_actor_test");
    let deleteCalled = false;

    const { safeDb } = createScopedDbMock({
      select: () => ({
        from: (table: unknown) => ({
          where: () => ({
            limit: () => ({
              for: async () =>
                table === timeEntries ? [{ id: "timer_test" }] : [],
            }),
            for: async () => {
              if (table === workspaces) {
                return [{ leadUserId: null }];
              }
              if (table === workspaceMembers) {
                return [
                  { id: "wm_timer", userId },
                  { id: "wm_other", userId: "user_other_test" },
                ];
              }
              return [];
            },
          }),
        }),
      }),
      delete: () => {
        deleteCalled = true;
        return {};
      },
    });

    const result = await Result.gen(() =>
      removeWorkspaceMemberHandler({
        safeDb,
        workspaceId,
        userId,
        actorUserId,
        recordAuditEvent: async () => undefined,
      }),
    );

    expect(Result.isError(result)).toBe(true);
    expect(result).toMatchObject({
      error: {
        status: 409,
        message: "Stop the member's active timer before removing them",
      },
    });
    expect(deleteCalled).toBe(false);
  });

  test("clears the workspace lead when removing that member", async () => {
    const deletedWorkspaceMemberId = toSafeId<"workspaceMember">("wm_lead");
    const updates: { table: string; value: unknown }[] = [];
    const insertedAuditLogs: unknown[] = [];
    const deletedWorkspaceMembers: unknown[] = [];

    const { safeDb, scopedDb } = createScopedDbMock({
      $count: async () => 0,
      select: () => ({
        from: (table: unknown) => ({
          innerJoin: () => ({
            ...createSelectQueryMock([]).from(),
            innerJoin: () => ({
              where: () => ({ as: () => ({}) }),
            }),
          }),
          where: () => ({
            orderBy: async () => await createSelectQueryMock([]).from().where(),
            limit: () => ({
              for: async () => [],
            }),
            for: async () => {
              if (table === workspaces) {
                return [{ leadUserId: "user_lead" }];
              }
              if (table === workspaceMembers) {
                return [
                  { id: "wm_lead", userId: "user_lead" },
                  { id: "wm_other", userId: "user_other" },
                ];
              }
              return [];
            },
          }),
        }),
      }),
      delete: (table: unknown) => ({
        where: () => ({
          returning: async () => {
            deletedWorkspaceMembers.push(table);
            return [{ id: deletedWorkspaceMemberId }];
          },
        }),
      }),
      update: (table: PgTable) => ({
        set: (value: unknown) => {
          updates.push({ table: getTableName(table), value });
          return {
            where: () => ({
              returning: async () => {
                if (table === desktopEditSessions) {
                  return [];
                }
                return [{ id: "ws_test123" }];
              },
            }),
          };
        },
      }),
      insert: (table: unknown) => ({
        values: (value: unknown) => {
          if (table === auditLogs) {
            insertedAuditLogs.push(value);
          }
        },
      }),
    });

    const result = await removeWorkspaceMember.handler(
      createContext({ safeDb, scopedDb }),
    );

    expect(result).toEqual({ id: deletedWorkspaceMemberId });
    expect(deletedWorkspaceMembers).toEqual([workspaceMembers]);
    // Signing transitions require a held session; this fixture has none.
    expect(updates).toEqual([
      {
        table: getTableName(desktopEditSessions),
        value: { takeoverRequestedBy: null, takeoverRequestedAt: null },
      },
      {
        table: getTableName(desktopEditHandoffs),
        value: { expiresAt: expect.any(Date), updatedAt: expect.any(Date) },
      },
      {
        table: getTableName(correspondence),
        value: { assigneeId: null, updatedAt: expect.any(Date) },
      },
      { table: getTableName(workspaces), value: { leadUserId: null } },
      {
        table: getTableName(desktopEditSessions),
        value: { status: "cancelled", closedAt: expect.any(Date) },
      },
    ]);
    expect(insertedAuditLogs.flat()).toHaveLength(2);
    expect(insertedAuditLogs.flat()).toEqual(
      [
        [
          expect.objectContaining({
            action: "delete",
            resourceId: "wm_lead",
            resourceType: "workspace_member",
          }),
        ],
        [
          expect.objectContaining({
            action: "update",
            changes: {
              leadUserId: {
                old: "user_lead",
                new: null,
              },
            },
            resourceId: "ws_test123",
            resourceType: "workspace",
          }),
        ],
      ].flat(),
    );
    expect(revokeWorkspaceSseAccessMock).toHaveBeenCalledWith(
      "ws_test123",
      "user_lead",
    );
  });
});
