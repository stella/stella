import { describe, expect, test } from "bun:test";

describe("workspace update cache invalidation", () => {
  test("invalidates the root workspace cache that covers sidebar navigation", async () => {
    process.env["VITE_API_URL"] = "http://localhost:3006";

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
});
