import { describe, expect, test } from "bun:test";

import { toSafeId } from "@/api/lib/branded-types";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createScopedDbMock } from "@/api/tests/scoped-db-mock";

import updateWorkspace from "./update";

type UpdateWorkspaceCtx = Parameters<typeof updateWorkspace.handler>[0];

const createContext = ({
  body,
  safeDb,
  scopedDb,
}: {
  body: UpdateWorkspaceCtx["body"];
  safeDb: UpdateWorkspaceCtx["safeDb"];
  scopedDb: UpdateWorkspaceCtx["scopedDb"];
}): UpdateWorkspaceCtx =>
  asTestRaw<UpdateWorkspaceCtx>({
    body,
    safeDb,
    scopedDb,
    memberRole: sessionMemberRole("owner"),
    orgAIConfig: null,
    request: new Request("https://api.example.test/v1/workspaces/ws_test123"),
    route: "/v1/workspaces/:workspaceId",
    session: {
      activeOrganizationId: toSafeId<"organization">("org_test123"),
    },
    user: { id: toSafeId<"user">("user_test123") },
    workspaceId: toSafeId<"workspace">("ws_test123"),
  });

describe("updateWorkspace", () => {
  test("rejects client changes to contacts outside the active organization", async () => {
    const workspaceSelect = {
      from: () => ({
        where: () => ({
          for: async () => [
            {
              id: "ws_test123",
              name: "Workspace",
              clientId: "contact_existing",
              reference: null,
              billingReference: null,
              color: null,
            },
          ],
        }),
      }),
    };
    const clientSelect = {
      from: () => ({
        where: () => ({
          for: () => ({
            limit: async () => [],
          }),
        }),
      }),
    };
    let selectCount = 0;

    const { getCallCount, safeDb, scopedDb } = createScopedDbMock({
      select: () => {
        selectCount++;
        return selectCount === 1 ? workspaceSelect : clientSelect;
      },
    });

    const result = await updateWorkspace.handler(
      createContext({
        body: {
          clientId: toSafeId<"contact">(Bun.randomUUIDv7()),
        },
        safeDb,
        scopedDb,
      }),
    );

    expect(result).toEqual({
      code: 404,
      response: { message: "Client not found" },
    });
    expect(getCallCount()).toBe(1);
  });

  test("looks up the contact when attaching a client to a personal matter", async () => {
    const workspaceRow = {
      id: "ws_test123",
      name: "Workspace",
      clientId: null,
      reference: null,
      billingReference: null,
      color: null,
      leadUserId: null,
    };
    const { safeDb, scopedDb } = createScopedDbMock({
      select: () => ({
        from: () => ({
          where: () => ({
            // oxlint-disable-next-line typescript/promise-function-async -- async would wrap the row promise and drop the limit the contact lookup chains
            for: () =>
              Object.assign(Promise.resolve([workspaceRow]), {
                limit: async () => [],
              }),
          }),
        }),
      }),
    });

    const result = await updateWorkspace.handler(
      createContext({
        body: {
          clientId: toSafeId<"contact">(Bun.randomUUIDv7()),
        },
        safeDb,
        scopedDb,
      }),
    );

    expect(result).toEqual({
      code: 404,
      response: { message: "Client not found" },
    });
  });
});
