import { describe, expect, test } from "bun:test";

import { auditLogs, workspaceMembers } from "@/api/db/schema";
import { createAuditRecorder } from "@/api/lib/audit-log";
import { toSafeId } from "@/api/lib/branded-types";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createScopedDbMock } from "@/api/tests/scoped-db-mock";

import addWorkspaceMember from "./workspace-members-add";

type AddMemberCtx = Parameters<typeof addWorkspaceMember.handler>[0];

const createContext = ({
  body,
  safeDb,
  scopedDb,
}: {
  body: AddMemberCtx["body"];
  safeDb: AddMemberCtx["safeDb"];
  scopedDb: AddMemberCtx["scopedDb"];
}): AddMemberCtx => {
  const recorderBindings = {
    organizationId: toSafeId<"organization">("org_test123"),
    workspaceId: toSafeId<"workspace">("ws_test123"),
    userId: toSafeId<"user">("user_test123"),
    request: new Request(
      "https://api.example.test/v1/workspaces/ws_test123/members",
    ),
    server: null,
  };

  return asTestRaw<AddMemberCtx>({
    body,
    safeDb,
    scopedDb,
    memberRole: { role: "owner" },
    orgAIConfig: null,
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

const selectRowsInOrder = (rowsByCall: unknown[][]) => {
  let callIndex = 0;

  return () => ({
    from: () => ({
      where: () => ({
        for: async () => rowsByCall.at(callIndex++) ?? [],
      }),
    }),
  });
};

const isArrayWithLength = (
  value: unknown,
  length: number,
): value is unknown[] => Array.isArray(value) && value.length === length;

describe("addWorkspaceMember", () => {
  test("adds a member to a personal matter", async () => {
    const createdAt = new Date("2026-01-01T00:00:00.000Z");
    const createdWorkspaceMemberId = toSafeId<"workspaceMember">(
      Bun.randomUUIDv7(),
    );
    const insertedWorkspaceMembers: unknown[] = [];
    const insertedAuditLogs: unknown[] = [];
    const { safeDb, scopedDb } = createScopedDbMock({
      query: {
        member: {
          findFirst: async () => ({ id: "member_existing" }),
        },
      },
      select: selectRowsInOrder([[{ id: "ws_test123" }], []]),
      insert: (table: unknown) => ({
        values: (value: unknown) => {
          if (table === workspaceMembers) {
            insertedWorkspaceMembers.push(value);
            return {
              returning: async () => [
                {
                  id: createdWorkspaceMemberId,
                  userId: "user_invitee",
                  createdAt,
                },
              ],
            };
          }

          if (table === auditLogs) {
            insertedAuditLogs.push(value);
          }

          return undefined;
        },
      }),
    });

    const result = await addWorkspaceMember.handler(
      createContext({
        body: { userId: "user_invitee" },
        safeDb,
        scopedDb,
      }),
    );

    expect(result).toEqual({
      id: createdWorkspaceMemberId,
      userId: "user_invitee",
      createdAt,
    });
    expect(insertedWorkspaceMembers).toEqual([
      {
        workspaceId: "ws_test123",
        userId: "user_invitee",
      },
    ]);
    expect(insertedAuditLogs).toHaveLength(1);
    const auditBatch = insertedAuditLogs.at(0);
    expect(isArrayWithLength(auditBatch, 1)).toBe(true);
    if (!isArrayWithLength(auditBatch, 1)) {
      throw new Error("Expected one audit log insert");
    }
    expect(auditBatch.at(0)).toEqual({
      action: "update",
      changes: {
        membersAdded: {
          old: null,
          new: ["user_invitee"],
        },
      },
      metadata: {
        forwardedFor: null,
        ipAddress: null,
        userAgent: null,
      },
      organizationId: "org_test123",
      resourceId: "ws_test123",
      resourceType: "workspace",
      userId: "user_test123",
      workspaceId: "ws_test123",
    });
  });

  test("rejects when the workspace cannot be found", async () => {
    const { safeDb, scopedDb } = createScopedDbMock({
      query: {
        member: {
          findFirst: async () => ({ id: "member_existing" }),
        },
      },
      select: selectRowsInOrder([[]]),
    });

    const result = await addWorkspaceMember.handler(
      createContext({
        body: { userId: "user_invitee" },
        safeDb,
        scopedDb,
      }),
    );

    expect(result).toEqual({
      code: 404,
      response: { message: "Workspace not found" },
    });
  });
});
