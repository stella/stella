import { describe, expect, test } from "bun:test";

describe("workspace update cache invalidation", () => {
  test("includes the navigation cache used by the sidebar", async () => {
    process.env["VITE_API_URL"] = "http://localhost:3006";

    const { workspaceUpdateInvalidationKeys } =
      await import("@/routes/_protected.workspaces/-mutations");
    const { workspacesKeys } =
      await import("@/routes/_protected.workspaces/-queries");
    const workspaceId = "workspace-1";

    expect(workspaceUpdateInvalidationKeys(workspaceId)).toContainEqual(
      workspacesKeys.navigation(),
    );
  });
});
