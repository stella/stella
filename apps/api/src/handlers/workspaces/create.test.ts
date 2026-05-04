import { describe, expect, test } from "bun:test";

import { toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { createScopedDbMock } from "@/api/tests/scoped-db-mock";

import createWorkspaces from "./create";

const createContext = ({
  body,
  safeDb,
  scopedDb,
}: {
  body: Parameters<typeof createWorkspaces.handler>[0]["body"];
  safeDb: Parameters<typeof createWorkspaces.handler>[0]["safeDb"];
  scopedDb: Parameters<typeof createWorkspaces.handler>[0]["scopedDb"];
}): Parameters<typeof createWorkspaces.handler>[0] =>
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test fixture only provides fields touched by the handler
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
  }) as Parameters<typeof createWorkspaces.handler>[0];

describe("createWorkspaces", () => {
  test("rejects teammate user IDs outside the active organization", async () => {
    const validTeamMemberId = "user_valid_member";
    const countSelect = {
      from: () => ({
        where: async () => [{ total: 0 }],
      }),
    };
    const clientSelect = {
      from: () => ({
        where: () => ({
          for: () => ({
            limit: async () => [{ id: Bun.randomUUIDv7() }],
          }),
        }),
      }),
    };
    const membersSelect = {
      from: () => ({
        where: () => ({
          for: async () => [{ userId: validTeamMemberId }],
        }),
      }),
    };

    const { getCallCount, safeDb, scopedDb } = createScopedDbMock({
      select: (fields: Record<string, unknown>) => {
        if ("total" in fields) {
          return countSelect;
        }

        if ("id" in fields) {
          return clientSelect;
        }

        return membersSelect;
      },
      query: {
        organizationSettings: {
          findFirst: async () => null,
        },
      },
    });

    const result = await createWorkspaces.handler(
      createContext({
        body: {
          id: toSafeId<"workspace">(Bun.randomUUIDv7()),
          clientId: toSafeId<"contact">(Bun.randomUUIDv7()),
          memberUserIds: [validTeamMemberId, "user_outside_org"],
          name: "Litigation intake",
          filePropertyName: "Documents",
        },
        safeDb,
        scopedDb,
      }),
    );

    expect(result).toEqual({
      code: 400,
      response: {
        message: "Some users are not members of this organization",
      },
    });
    expect(getCallCount()).toBe(1);
  });

  test("personal workspace skips the contacts lookup", async () => {
    // Force an early return on the workspaces-limit branch so the
    // handler never reaches the audit log (which the test fixture
    // does not set up). The assertion of interest is that the
    // contact lookup query was not issued at all.
    const countSelect = {
      from: () => ({
        where: async () => [{ total: 1_000_000 }],
      }),
    };
    let clientSelectCalls = 0;

    const { safeDb, scopedDb } = createScopedDbMock({
      select: (fields: Record<string, unknown>) => {
        if ("total" in fields) {
          return countSelect;
        }
        if ("id" in fields) {
          clientSelectCalls += 1;
          return {
            from: () => ({
              where: () => ({
                for: () => ({
                  limit: async () => [],
                }),
              }),
            }),
          };
        }
        return {
          from: () => ({
            where: () => ({
              for: async () => [],
            }),
          }),
        };
      },
      query: {
        organizationSettings: {
          findFirst: async () => null,
        },
      },
    });

    const result = await createWorkspaces.handler(
      createContext({
        body: {
          id: toSafeId<"workspace">(Bun.randomUUIDv7()),
          name: "Scratchpad",
          filePropertyName: "Documents",
        },
        safeDb,
        scopedDb,
      }),
    );

    // 400 from the workspaces-limit branch confirms we got past the
    // schema gate without a client lookup; 0 calls confirms the
    // contacts table was never queried for a personal matter.
    expect(result).toEqual({
      code: 400,
      response: { message: "Workspaces limit reached" },
    });
    expect(clientSelectCalls).toBe(0);
  });
});
