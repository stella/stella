import { QueryClient } from "@tanstack/react-query";
import { describe, expect, test } from "bun:test";

import { entitiesKeys } from "@/routes/_protected.workspaces/$workspaceId/-queries/entities.logic";
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
