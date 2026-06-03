import { describe, expect, test } from "bun:test";

import { member } from "@/api/db/auth-schema";
import {
  auditLogs,
  matterCounters,
  workspaceMembers,
  workspaces,
} from "@/api/db/schema";
import { createAuditRecorder } from "@/api/lib/audit-log";
import { toSafeId } from "@/api/lib/branded-types";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createScopedDbMock } from "@/api/tests/scoped-db-mock";

import duplicateWorkspace from "./duplicate";

type DuplicateWorkspaceCtx = Parameters<typeof duplicateWorkspace.handler>[0];

const createContext = ({
  safeDb,
  scopedDb,
}: {
  safeDb: DuplicateWorkspaceCtx["safeDb"];
  scopedDb: DuplicateWorkspaceCtx["scopedDb"];
}): DuplicateWorkspaceCtx => {
  const recorderBindings = {
    organizationId: toSafeId<"organization">("org_test123"),
    workspaceId: toSafeId<"workspace">("ws_source123"),
    userId: toSafeId<"user">("user_test123"),
    request: new Request(
      "https://api.example.test/v1/workspaces/ws_source123/duplicate",
    ),
    server: null,
  };

  return asTestRaw<DuplicateWorkspaceCtx>({
    body: { includeContent: false },
    safeDb,
    scopedDb,
    memberRole: { role: "owner" },
    orgAIConfig: null,
    request: recorderBindings.request,
    route: "/v1/workspaces/:workspaceId/duplicate",
    session: {
      activeOrganizationId: recorderBindings.organizationId,
    },
    user: { id: recorderBindings.userId },
    workspaceId: recorderBindings.workspaceId,
    recordAuditEvent: createAuditRecorder(recorderBindings),
    createAuditRecorder: () => createAuditRecorder(recorderBindings),
  });
};

describe("duplicateWorkspace", () => {
  test("copies the workspace lead when duplicating a matter", async () => {
    const insertedWorkspaces: unknown[] = [];
    const insertedWorkspaceMembers: unknown[] = [];
    const insertedAuditLogs: unknown[] = [];

    const { safeDb, scopedDb } = createScopedDbMock({
      query: {
        workspaces: {
          findFirst: async () => ({
            id: "ws_source123",
            name: "Smith v Jones",
            clientId: "contact_client123",
            billingReference: "BILL-123",
            color: "blue",
            leadUserId: "user_lead123",
          }),
        },
        properties: {
          findMany: async () => [],
        },
        propertyDependencies: {
          findMany: async () => [],
        },
        workspaceViews: {
          findMany: async () => [],
        },
        workspaceMembers: {
          findMany: async () => [{ userId: "user_lead123" }],
        },
        workspaceContacts: {
          findMany: async () => [],
        },
        organizationSettings: {
          findFirst: async () => null,
        },
      },
      select: (fields: Record<string, unknown>) => {
        if ("total" in fields) {
          return {
            from: () => ({
              where: async () => [{ total: 0 }],
            }),
          };
        }

        if ("name" in fields) {
          return {
            from: () => ({
              where: async () => [],
            }),
          };
        }

        if ("userId" in fields) {
          return {
            from: (table: unknown) => {
              expect(table).toBe(member);
              return {
                where: async () => [{ userId: "user_lead123" }],
              };
            },
          };
        }

        throw new Error("Unexpected select fields");
      },
      insert: (table: unknown) => ({
        values: (value: unknown) => {
          if (table === matterCounters) {
            return {
              onConflictDoUpdate: () => ({
                returning: async () => [{ lastValue: 1 }],
              }),
            };
          }

          if (table === workspaces) {
            insertedWorkspaces.push(value);
            return undefined;
          }

          if (table === workspaceMembers) {
            insertedWorkspaceMembers.push(value);
            return undefined;
          }

          if (table === auditLogs) {
            insertedAuditLogs.push(value);
            return undefined;
          }

          throw new Error("Unexpected insert table");
        },
      }),
      execute: async () => undefined,
    });

    const result = await duplicateWorkspace.handler(
      createContext({ safeDb, scopedDb }),
    );

    expect(result).toEqual({ workspaceId: expect.any(String) });
    expect(insertedWorkspaces).toEqual([
      expect.objectContaining({
        billingReference: "BILL-123",
        clientId: "contact_client123",
        color: "blue",
        leadUserId: "user_lead123",
        name: "Smith v Jones",
      }),
    ]);
    expect(insertedWorkspaceMembers).toEqual([
      [
        expect.objectContaining({
          userId: "user_lead123",
        }),
      ],
    ]);
    expect(insertedAuditLogs).toHaveLength(1);
  });
});
