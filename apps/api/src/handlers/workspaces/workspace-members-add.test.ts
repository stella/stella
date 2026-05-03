import { describe, expect, test } from "bun:test";

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

const workspaceSelect = (rows: { clientId: string | null }[]) => ({
  from: () => ({
    where: () => ({
      for: async () => rows,
    }),
  }),
});

describe("addWorkspaceMember", () => {
  test("rejects adding a member to a personal matter", async () => {
    const { safeDb, scopedDb } = createScopedDbMock({
      query: {
        member: {
          findFirst: async () => ({ id: "member_existing" }),
        },
      },
      select: () => workspaceSelect([{ clientId: null }]),
    });

    const result = await addWorkspaceMember.handler(
      createContext({
        body: { userId: "user_invitee" },
        safeDb,
        scopedDb,
      }),
    );

    expect(result).toEqual({
      code: 400,
      response: { message: "Assign a client before adding members" },
    });
  });

  test("rejects when the workspace cannot be found", async () => {
    const { safeDb, scopedDb } = createScopedDbMock({
      query: {
        member: {
          findFirst: async () => ({ id: "member_existing" }),
        },
      },
      select: () => workspaceSelect([]),
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
