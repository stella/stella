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

  test("only name updates have a document-title side effect", async () => {
    const { workspaceUpdateEffects } =
      await import("@/lib/workspaces/mutations");

    expect(
      workspaceUpdateEffects({ type: "name", value: "Renamed matter" }),
    ).toEqual({ documentTitle: "Renamed matter" });

    expect([
      workspaceUpdateEffects({ type: "clientId", value: "contact_test" }),
      workspaceUpdateEffects({ type: "color", value: "purple" }),
      workspaceUpdateEffects({ type: "leadUserId", value: "user_test" }),
      workspaceUpdateEffects({
        type: "promote",
        value: { clientId: "contact_test" },
      }),
      workspaceUpdateEffects({ type: "reference", value: "REF-42" }),
    ]).toEqual([
      { documentTitle: null },
      { documentTitle: null },
      { documentTitle: null },
      { documentTitle: null },
      { documentTitle: null },
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
