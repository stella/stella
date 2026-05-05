import { describe, expect, test } from "bun:test";

import { auditLogs, workspaceMembers } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { createScopedDbMock } from "@/api/tests/scoped-db-mock";

import addWorkspaceMember from "./workspace-members-add";

const createContext = ({
  body,
  safeDb,
  scopedDb,
}: {
  body: Parameters<typeof addWorkspaceMember.handler>[0]["body"];
  safeDb: Parameters<typeof addWorkspaceMember.handler>[0]["safeDb"];
  scopedDb: Parameters<typeof addWorkspaceMember.handler>[0]["scopedDb"];
}): Parameters<typeof addWorkspaceMember.handler>[0] =>
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test fixture only provides the fields used by the handler
  ({
    body,
    safeDb,
    scopedDb,
    memberRole: { role: "owner" },
    orgAIConfig: null,
    request: new Request("http://localhost/v1/workspaces/ws_test123/members"),
    session: {
      activeOrganizationId:
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- branded test value
        "org_test123" as SafeId<"organization">,
    },
    user: {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- branded test value
      id: "user_test123" as SafeId<"user">,
    },
    workspaceId:
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- branded test value
      "ws_test123" as SafeId<"workspace">,
  }) as Parameters<typeof addWorkspaceMember.handler>[0];

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
    const createdWorkspaceMemberId =
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- branded test value
      Bun.randomUUIDv7() as SafeId<"workspaceMember">;
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
