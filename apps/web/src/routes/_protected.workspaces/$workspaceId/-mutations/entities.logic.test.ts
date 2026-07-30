import { QueryClient } from "@tanstack/react-query";
import { describe, expect, test } from "bun:test";

import { invalidateDeletedEntityQueries } from "@/routes/_protected.workspaces/$workspaceId/-mutations/entities.logic";
import { entitiesKeys } from "@/routes/_protected.workspaces/$workspaceId/-queries/entities.logic";
import { taskKeys } from "@/routes/_protected.workspaces/$workspaceId/-queries/tasks.logic";
import { workspacesKeys } from "@/routes/_protected.workspaces/-queries.logic";

describe("deleted entity cache invalidation", () => {
  test("marks entity, task, and overview queries stale", async () => {
    const queryClient = new QueryClient();
    const entityDetailKey = entitiesKeys.detail("workspace-1", "entity-1");
    const taskDetailKey = taskKeys.detail("workspace-1", "entity-1");
    const overviewKey = workspacesKeys.overview("workspace-1");
    const otherWorkspaceKey = entitiesKeys.detail("workspace-2", "entity-1");
    for (const queryKey of [
      entityDetailKey,
      taskDetailKey,
      overviewKey,
      otherWorkspaceKey,
    ]) {
      queryClient.setQueryData(queryKey, { seeded: true });
    }

    await invalidateDeletedEntityQueries({
      queryClient,
      workspaceId: "workspace-1",
    });

    expect(queryClient.getQueryState(entityDetailKey)?.isInvalidated).toBe(
      true,
    );
    expect(queryClient.getQueryState(taskDetailKey)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(overviewKey)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(otherWorkspaceKey)?.isInvalidated).toBe(
      false,
    );
  });
});
