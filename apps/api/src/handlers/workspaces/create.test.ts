import { describe, expect, test } from "bun:test";

import {
  documentReferenceCounters,
  matterCounters,
  properties,
  searchProjectionRepairQueue,
  workspaceViews,
} from "@/api/db/schema";
import { toSafeId } from "@/api/lib/branded-types";
import { MAX_MATTER_REFERENCE_ALLOCATION_ATTEMPTS } from "@/api/lib/matter-reference";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  createScopedDbMock,
  createSelectQueryMock,
} from "@/api/tests/scoped-db-mock";

import createWorkspaces from "./create";

type CreateWorkspacesCtx = Parameters<typeof createWorkspaces.handler>[0];

const createContext = ({
  body,
  safeDb,
  scopedDb,
}: {
  body: CreateWorkspacesCtx["body"];
  safeDb: CreateWorkspacesCtx["safeDb"];
  scopedDb: CreateWorkspacesCtx["scopedDb"];
}): CreateWorkspacesCtx =>
  asTestRaw<CreateWorkspacesCtx>({
    body,
    request: new Request("https://example.test/v1/workspaces", {
      method: "PUT",
    }),
    route: "/v1/workspaces",
    safeDb,
    scopedDb,
    memberRole: { role: "owner" },
    orgAIConfig: null,
    session: {
      activeOrganizationId: toSafeId<"organization">("org_test123"),
    },
    user: { id: toSafeId<"user">("user_test123") },
    recordAuditEvent: async () => {},
  });

describe("createWorkspaces", () => {
  test.each(["personal", "client"])(
    "seeds a file column for a %s matter",
    async (kind) => {
      const insertedProperties: unknown[] = [];
      const propertyId = toSafeId<"property">(Bun.randomUUIDv7());
      const workspaceId = toSafeId<"workspace">(Bun.randomUUIDv7());
      const clientId = toSafeId<"contact">(Bun.randomUUIDv7());
      const { safeDb, scopedDb } = createScopedDbMock({
        query: { organizationSettings: { findFirst: async () => null } },
        select: (selected: Record<string, unknown>) => {
          if (selected["reference"] === documentReferenceCounters.reference) {
            return createSelectQueryMock([]);
          }
          if ("total" in selected) {
            return createSelectQueryMock([{ total: 0 }]);
          }
          if ("id" in selected) {
            return {
              from: () => ({
                where: () => ({
                  for: () => ({ limit: async () => [{ id: clientId }] }),
                }),
              }),
            };
          }
          return createSelectQueryMock([]);
        },
        insert: (table: unknown) => ({
          select: () => ({ onConflictDoUpdate: async () => undefined }),
          values: (value: unknown) => {
            if (table === matterCounters) {
              return {
                onConflictDoUpdate: () => ({
                  returning: async () => [
                    { lastValue: MAX_MATTER_REFERENCE_ALLOCATION_ATTEMPTS },
                  ],
                }),
              };
            }
            if (table === properties) {
              insertedProperties.push(value);
              return { returning: async () => [{ id: propertyId }] };
            }
            if (table === workspaceViews) {
              return { returning: async () => [] };
            }
            expect(table).not.toBe(searchProjectionRepairQueue);
            return undefined;
          },
        }),
        update: () => ({ set: () => ({ where: async () => undefined }) }),
      });

      const result = await createWorkspaces.handler(
        createContext({
          safeDb,
          scopedDb,
          body: {
            id: workspaceId,
            ...(kind === "client" ? { clientId } : {}),
            name: "Matter with documents",
            filePropertyName: "Documents",
          },
        }),
      );

      expect(result).toEqual({ id: workspaceId });
      expect(insertedProperties).toEqual([
        [
          expect.objectContaining({
            workspaceId,
            name: "Documents",
            content: { type: "file", version: 1 },
            tool: { version: 1, type: "manual-input" },
            system: true,
            kinds: ["document"],
          }),
        ],
      ]);
    },
  );

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
