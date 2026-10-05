import { describe, expect, test } from "bun:test";

import { member } from "@/api/db/auth-schema";
import { auditLogs, workspaceMembers } from "@/api/db/schema";
import { ORG_AI_CONFIG_STATUS } from "@/api/lib/ai-config-loader-core";
import { createAuditRecorder } from "@/api/lib/audit-log";
import { toSafeId } from "@/api/lib/branded-types";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createScopedDbMock } from "@/api/tests/scoped-db-mock";

import addWorkspaceMember from "./add";

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
    memberRole: sessionMemberRole("owner"),
    orgAIConfig: null,
    orgAIConfigStatus: ORG_AI_CONFIG_STATUS.ok,
    managedAIResidency: "eu" as const,
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

const selectRowsInOrder = (rowsByCall: unknown[][], isMember = true) => {
  let callIndex = 0;

  return () => ({
    from: (table: unknown) => ({
      where: () => ({
        for: async () => {
          if (table === member) {
            return isMember ? [{ id: "member_existing" }] : [];
          }
          return rowsByCall.at(callIndex++) ?? [];
        },
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
      activityCategory: "team",
      approvalStatus: "not_required",
      approvedByUserId: null,
      changes: {
        membersAdded: {
          old: null,
          new: ["user_invitee"],
        },
      },
      groupId: expect.any(String),
      metadata: {
        forwardedFor: null,
        ipAddress: null,
        userAgent: null,
      },
      organizationId: "org_test123",
      performerId: "user_test123",
      performerName: null,
      performerType: "user",
      resourceId: "ws_test123",
      resourceType: "workspace",
      runId: null,
      triggerSource: null,
      triggerSourceId: null,
      triggerType: "direct",
      triggerUserId: null,
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

test("matter membership cannot be added without current organization membership", async () => {
  const { safeDb, scopedDb } = createScopedDbMock({
    select: selectRowsInOrder([[{ id: "ws_test123" }]], false),
  });
  expect(
    await addWorkspaceMember.handler(
      createContext({ body: { userId: "user_invitee" }, safeDb, scopedDb }),
    ),
  ).toMatchObject({
    code: 400,
    response: { message: "User is not a member of this organization" },
  });
});
