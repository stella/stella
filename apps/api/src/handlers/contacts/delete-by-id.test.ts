import { describe, expect, test } from "bun:test";

import type { SafeId } from "@/api/lib/branded-types";
import { createScopedDbMock } from "@/api/tests/scoped-db-mock";

import deleteContactById from "./delete-by-id";

const createContext = ({
  contactId,
  scopedDb,
}: {
  contactId: string;
  scopedDb: Parameters<typeof deleteContactById.handler>[0]["scopedDb"];
}): Parameters<typeof deleteContactById.handler>[0] =>
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test fixture only provides fields touched by the handler
  ({
    params: { contactId },
    scopedDb,
    memberRole: { role: "owner" },
    session: {
      activeOrganizationId:
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- branded test value
        "org_test123" as SafeId<"organization">,
      token: "token",
    },
    user: {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- branded test value
      id: "user_test123" as SafeId<"user">,
    },
    orgAIConfig: null,
  }) as Parameters<typeof deleteContactById.handler>[0];

describe("deleteContactById", () => {
  test("blocks deleting a contact assigned as a matter client", async () => {
    let deleteCalled = false;
    const { getCallCount, scopedDb } = createScopedDbMock({
      select: () => ({
        from: () => ({
          where: () => ({
            for: () => ({
              limit: async () => [{ id: "contact_test123" }],
            }),
          }),
        }),
      }),
      $count: async () => 2,
      delete: () => ({
        where: async () => {
          deleteCalled = true;
          return [];
        },
      }),
    });

    const result = await deleteContactById.handler(
      createContext({
        contactId: crypto.randomUUID(),
        scopedDb,
      }),
    );

    expect(result).toEqual({
      code: 409,
      response: {
        message: "Reassign or delete 2 matters before deleting this contact",
      },
    });
    expect(getCallCount()).toBe(1);
    expect(deleteCalled).toBe(false);
  });

  test("returns 404 when the contact does not exist", async () => {
    const { getCallCount, scopedDb } = createScopedDbMock({
      select: () => ({
        from: () => ({
          where: () => ({
            for: () => ({
              limit: async () => [],
            }),
          }),
        }),
      }),
      $count: async () => 0,
      delete: () => ({
        where: async () => [],
      }),
    });

    const result = await deleteContactById.handler(
      createContext({
        contactId: crypto.randomUUID(),
        scopedDb,
      }),
    );

    expect(result).toEqual({
      code: 404,
      response: {
        message: "Contact not found",
      },
    });
    expect(getCallCount()).toBe(1);
  });
});
