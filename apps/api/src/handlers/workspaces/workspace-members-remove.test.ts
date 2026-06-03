import { describe, expect, test } from "bun:test";

import {
  auditLogs,
  desktopEditSessions,
  workspaceMembers,
  workspaces,
} from "@/api/db/schema";
import { createAuditRecorder } from "@/api/lib/audit-log";
import { toSafeId } from "@/api/lib/branded-types";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createScopedDbMock } from "@/api/tests/scoped-db-mock";

import removeWorkspaceMember from "./workspace-members-remove";

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
    request: new Request("http://localhost/v1/workspaces/ws_test123/members"),
    server: null,
  };

  return asTestRaw<RemoveMemberCtx>({
    safeDb,
    scopedDb,
    memberRole: { role: "owner" },
    orgAIConfig: null,
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
  test("clears the workspace lead when removing that member", async () => {
    const deletedWorkspaceMemberId = toSafeId<"workspaceMember">("wm_lead");
    const updates: { table: unknown; value: unknown }[] = [];
    const insertedAuditLogs: unknown[] = [];
    const deletedWorkspaceMembers: unknown[] = [];

    const { safeDb, scopedDb } = createScopedDbMock({
      select: () => ({
        from: (table: unknown) => ({
          where: () => ({
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
      update: (table: unknown) => ({
        set: (value: unknown) => {
          updates.push({ table, value });
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
    expect(updates).toEqual([
      { table: workspaces, value: { leadUserId: null } },
      {
        table: desktopEditSessions,
        value: { status: "cancelled", closedAt: expect.any(Date) },
      },
    ]);
    expect(insertedAuditLogs).toHaveLength(2);
    expect(insertedAuditLogs).toEqual([
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
    ]);
  });
});
