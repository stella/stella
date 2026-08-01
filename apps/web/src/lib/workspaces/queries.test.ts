import { QueryClient } from "@tanstack/react-query";
import { describe, expect, test } from "bun:test";

import {
  invalidateWorkspaceActivity,
  workspacesKeys,
} from "@/lib/workspaces/queries";
import { entitiesKeys } from "@/lib/workspaces/queries/entities.logic";

describe("workspace activity invalidation", () => {
  test("invalidates every organization-scoped page for one workspace", async () => {
    const queryClient = new QueryClient();
    const targetKey = workspacesKeys.activity("organization-a", {
      workspaceId: "workspace-a",
    });
    const otherKey = workspacesKeys.activity("organization-a", {
      workspaceId: "workspace-b",
    });
    const overviewKey = workspacesKeys.overviewActivity(
      "organization-a",
      "workspace-a",
      "all",
    );
    queryClient.setQueryData(targetKey, { pages: [] });
    queryClient.setQueryData(otherKey, { pages: [] });
    queryClient.setQueryData(overviewKey, { pages: [] });

    await invalidateWorkspaceActivity(queryClient, "workspace-a");

    expect(queryClient.getQueryState(targetKey)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(overviewKey)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(otherKey)?.isInvalidated).toBe(false);
  });

  test("inherits entity invalidation through the shared parent key", async () => {
    const queryClient = new QueryClient();
    const activityKey = workspacesKeys.activity("organization-a", {
      workspaceId: "workspace-a",
    });
    queryClient.setQueryData(activityKey, { pages: [] });

    await queryClient.invalidateQueries({
      queryKey: entitiesKeys.all("workspace-a"),
    });

    expect(queryClient.getQueryState(activityKey)?.isInvalidated).toBe(true);
  });
});
