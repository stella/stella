import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import type { WorkspaceUpdate } from "@/lib/workspaces/mutations";

const previousApiUrl = process.env["VITE_API_URL"];

beforeAll(() => {
  process.env["VITE_API_URL"] = previousApiUrl ?? "https://api.example.test";
});

afterAll(() => {
  if (previousApiUrl === undefined) {
    delete process.env["VITE_API_URL"];
    return;
  }
  process.env["VITE_API_URL"] = previousApiUrl;
});

describe("workspace update cache invalidation", () => {
  test("invalidates the root workspace cache that covers sidebar navigation", async () => {
    const { workspaceUpdateInvalidationKeys } =
      await import("@/lib/workspaces/mutations");
    const { workspacesKeys } = await import("@/lib/workspaces/queries");

    expect(workspaceUpdateInvalidationKeys()).toContainEqual(
      workspacesKeys.all,
    );
    expect(
      workspacesKeys.navigation("org_test").slice(0, workspacesKeys.all.length),
    ).toEqual(workspacesKeys.all);
  });

  test("refetches active workspace caches and the inactive loader cache", async () => {
    const { workspaceUpdateRefetchFilters } =
      await import("@/lib/workspaces/mutations");
    const { workspacesKeys } = await import("@/lib/workspaces/queries");

    expect(workspaceUpdateRefetchFilters("ws_test")).toEqual([
      { queryKey: workspacesKeys.all, type: "active" },
      {
        exact: true,
        queryKey: workspacesKeys.byId("ws_test"),
        type: "inactive",
      },
    ]);
  });

  test("assigns every update kind its exact refresh scope", async () => {
    const { workspaceUpdateRefreshScope } =
      await import("@/lib/workspaces/mutations");

    const updates = {
      clientId: {
        type: "clientId",
        value: "contact_test",
      },
      color: { type: "color", value: "purple" },
      leadUserId: {
        type: "leadUserId",
        value: "user_test",
      },
      name: { type: "name", value: "Renamed matter" },
      promote: {
        type: "promote",
        value: { clientId: "contact_test" },
      },
      reference: { type: "reference", value: "REF-42" },
    } as const satisfies {
      [Type in WorkspaceUpdate["type"]]: Extract<
        WorkspaceUpdate,
        { type: Type }
      >;
    };
    const scopes = Object.fromEntries(
      Object.values(updates).map((update) => [
        update.type,
        workspaceUpdateRefreshScope(update),
      ]),
    );

    expect(scopes).toEqual({
      clientId: "query-cache",
      color: "query-cache",
      leadUserId: "query-cache",
      name: "route-metadata",
      promote: "query-cache",
      reference: "query-cache",
    });
  });

  test("maps every workspace update variant to its API body", async () => {
    const { workspaceUpdateBody } = await import("@/lib/workspaces/mutations");
    const { toSafeId } = await import("@/lib/safe-id");
    const contactId = toSafeId<"contact">("contact_test");

    const bodies = [
      workspaceUpdateBody({ type: "clientId", value: "contact_test" }),
      workspaceUpdateBody({ type: "color", value: "purple" }),
      workspaceUpdateBody({ type: "color", value: null }),
      workspaceUpdateBody({ type: "leadUserId", value: "user_test" }),
      workspaceUpdateBody({ type: "leadUserId", value: null }),
      workspaceUpdateBody({ type: "name", value: "Renamed matter" }),
      workspaceUpdateBody({
        type: "promote",
        value: { clientId: "contact_test", memberUserIds: [] },
      }),
      workspaceUpdateBody({
        type: "promote",
        value: {
          clientId: "contact_test",
          memberUserIds: ["user_one", "user_two"],
        },
      }),
      workspaceUpdateBody({ type: "reference", value: "REF-42" }),
    ];

    expect(bodies).toEqual([
      { clientId: contactId },
      { color: "purple" },
      { color: null },
      { leadUserId: "user_test" },
      { leadUserId: null },
      { name: "Renamed matter" },
      { promote: { clientId: contactId } },
      {
        promote: {
          clientId: contactId,
          memberUserIds: ["user_one", "user_two"],
        },
      },
      { reference: "REF-42" },
    ]);
  });

  test("member mutations invalidate the members query and the matters list", async () => {
    const { workspaceMemberMutationInvalidationKeys } =
      await import("@/lib/workspaces/mutations/workspace-members");
    const { workspaceMembersKeys } =
      await import("@/lib/workspaces/queries/workspace-members");
    const { workspacesKeys } = await import("@/lib/workspaces/queries");

    expect(workspaceMemberMutationInvalidationKeys("ws_test")).toEqual([
      workspaceMembersKeys.all("ws_test"),
      workspacesKeys.all,
    ]);
  });
});
