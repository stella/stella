import { afterAll, beforeAll, describe, expect, test } from "bun:test";

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

  test("only name updates invalidate the current route metadata", async () => {
    const { workspaceUpdateInvalidatesRoute } =
      await import("@/lib/workspaces/mutations");

    expect([
      workspaceUpdateInvalidatesRoute({
        type: "name",
        value: "Renamed matter",
      }),
      workspaceUpdateInvalidatesRoute({
        type: "clientId",
        value: "contact_test",
      }),
      workspaceUpdateInvalidatesRoute({ type: "color", value: "purple" }),
      workspaceUpdateInvalidatesRoute({
        type: "leadUserId",
        value: "user_test",
      }),
      workspaceUpdateInvalidatesRoute({
        type: "promote",
        value: { clientId: "contact_test" },
      }),
      workspaceUpdateInvalidatesRoute({
        type: "reference",
        value: "REF-42",
      }),
    ]).toEqual([true, false, false, false, false, false]);
  });

  test("maps every workspace update variant to its API body", async () => {
    const { workspaceUpdateBody } = await import("@/lib/workspaces/mutations");

    const bodies: unknown = [
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
      { clientId: "contact_test" },
      { color: "purple" },
      { color: null },
      { leadUserId: "user_test" },
      { leadUserId: null },
      { name: "Renamed matter" },
      { promote: { clientId: "contact_test" } },
      {
        promote: {
          clientId: "contact_test",
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
