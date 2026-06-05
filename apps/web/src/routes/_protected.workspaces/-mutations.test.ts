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
      await import("@/routes/_protected.workspaces/-mutations");
    const { workspacesKeys } =
      await import("@/routes/_protected.workspaces/-queries");

    expect(workspaceUpdateInvalidationKeys()).toContainEqual(
      workspacesKeys.all,
    );
    expect(
      workspacesKeys.navigation("org_test").slice(0, workspacesKeys.all.length),
    ).toEqual(workspacesKeys.all);
  });

  test("refetches active workspace caches and the inactive loader cache", async () => {
    const { workspaceUpdateRefetchFilters } =
      await import("@/routes/_protected.workspaces/-mutations");
    const { workspacesKeys } =
      await import("@/routes/_protected.workspaces/-queries");

    expect(workspaceUpdateRefetchFilters("ws_test")).toEqual([
      { queryKey: workspacesKeys.all, type: "active" },
      {
        exact: true,
        queryKey: workspacesKeys.byId("ws_test"),
        type: "inactive",
      },
    ]);
  });

  test("member mutations invalidate the members query and the matters list", async () => {
    const { workspaceMemberMutationInvalidationKeys } =
      await import("@/routes/_protected.workspaces/$workspaceId/-mutations/workspace-members");
    const { workspaceMembersKeys } =
      await import("@/routes/_protected.workspaces/$workspaceId/-queries/workspace-members");
    const { workspacesKeys } =
      await import("@/routes/_protected.workspaces/-queries");

    expect(workspaceMemberMutationInvalidationKeys("ws_test")).toEqual([
      workspaceMembersKeys.all("ws_test"),
      workspacesKeys.all,
    ]);
  });
});
