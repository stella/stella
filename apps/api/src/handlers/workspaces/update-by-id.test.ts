import { describe, expect, test } from "bun:test";

import { toSafeId } from "@/api/lib/branded-types";
import { createScopedDbMock } from "@/api/tests/scoped-db-mock";

import updateWorkspace from "./update-by-id";

const createContext = ({
  body,
  safeDb,
  scopedDb,
}: {
  body: Parameters<typeof updateWorkspace.handler>[0]["body"];
  safeDb: Parameters<typeof updateWorkspace.handler>[0]["safeDb"];
  scopedDb: Parameters<typeof updateWorkspace.handler>[0]["scopedDb"];
}): Parameters<typeof updateWorkspace.handler>[0] =>
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test fixture only provides the fields used by the handler
  ({
    body,
    safeDb,
    scopedDb,
    memberRole: { role: "owner" },
    orgAIConfig: null,
    request: new Request("http://localhost/v1/workspaces/ws_test123"),
    session: {
      activeOrganizationId: toSafeId<"organization">("org_test123"),
    },
    user: { id: toSafeId<"user">("user_test123") },
    workspaceId: toSafeId<"workspace">("ws_test123"),
  }) as Parameters<typeof updateWorkspace.handler>[0];

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

  test("rejects promote on an already-client workspace", async () => {
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

    const { safeDb, scopedDb } = createScopedDbMock({
      select: () => workspaceSelect,
    });

    const result = await updateWorkspace.handler(
      createContext({
        body: {
          promote: {
            clientId: toSafeId<"contact">(Bun.randomUUIDv7()),
          },
        },
        safeDb,
        scopedDb,
      }),
    );

    expect(result).toEqual({
      code: 400,
      response: { message: "Workspace is already a client matter" },
    });
  });

  test("rejects clientId update on a personal workspace", async () => {
    const workspaceSelect = {
      from: () => ({
        where: () => ({
          for: async () => [
            {
              id: "ws_test123",
              name: "Workspace",
              clientId: null,
              reference: null,
              billingReference: null,
              color: null,
            },
          ],
        }),
      }),
    };

    const { safeDb, scopedDb } = createScopedDbMock({
      select: () => workspaceSelect,
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
      code: 400,
      response: {
        message: "Use promote to attach a client to a personal matter",
      },
    });
  });
});
