import { describe, expect, test } from "bun:test";

import type { SafeId } from "@/api/lib/branded-types";
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
  }) as Parameters<typeof updateWorkspace.handler>[0];

describe("updateWorkspace", () => {
  test("rejects client changes to contacts outside the active organization", async () => {
    const clientSelect = {
      from: () => ({
        where: () => ({
          for: () => ({
            limit: async () => [],
          }),
        }),
      }),
    };

    const { getCallCount, safeDb, scopedDb } = createScopedDbMock({
      select: () => clientSelect,
    });

    const result = await updateWorkspace.handler(
      createContext({
        body: {
          clientId: crypto.randomUUID(),
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
});
