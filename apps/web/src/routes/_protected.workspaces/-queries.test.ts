import { QueryClient } from "@tanstack/react-query";
import { describe, expect, test } from "bun:test";

import {
  invalidateWorkspaceActivity,
  workspacesKeys,
} from "@/routes/_protected.workspaces/-queries";

describe("workspace activity invalidation", () => {
  test("invalidates every organization-scoped page for one workspace", async () => {
    const queryClient = new QueryClient();
    const targetKey = workspacesKeys.activity("organization-a", {
      workspaceId: "workspace-a",
    });
    const otherKey = workspacesKeys.activity("organization-a", {
      workspaceId: "workspace-b",
    });
    queryClient.setQueryData(targetKey, { pages: [] });
    queryClient.setQueryData(otherKey, { pages: [] });

    await invalidateWorkspaceActivity(queryClient, "workspace-a");

    expect(queryClient.getQueryState(targetKey)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(otherKey)?.isInvalidated).toBe(false);
  });
});
