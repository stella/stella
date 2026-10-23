import { QueryClient } from "@tanstack/react-query";
import { describe, expect, test } from "bun:test";

import { invalidateDeletedEntityQueries } from "@/lib/workspaces/mutations/entities.logic";
import { workspacesKeys } from "@/lib/workspaces/queries.logic";
import { entitiesKeys } from "@/lib/workspaces/queries/entities.logic";
import { taskKeys } from "@/lib/workspaces/queries/tasks.logic";

describe("deleted entity cache invalidation", () => {
  test("marks entity, task, and overview queries stale", async () => {
    const queryClient = new QueryClient();
    const entityDetailKey = entitiesKeys.detail("workspace-1", "entity-1");
    const untouchedEntityKey = entitiesKeys.detail("workspace-1", "entity-2");
    const collectionKey = entitiesKeys.window({
      workspaceId: "workspace-1",
      filters: [],
      sorts: [],
    });
    const taskDetailKey = taskKeys.detail("workspace-1", "entity-1");
    const overviewKey = workspacesKeys.overview("workspace-1");
    const otherWorkspaceKey = entitiesKeys.detail("workspace-2", "entity-1");
    for (const queryKey of [
      entityDetailKey,
      untouchedEntityKey,
      collectionKey,
      entitiesKeys.folders("workspace-1"),
      entitiesKeys.files("workspace-1"),
      taskDetailKey,
      overviewKey,
      otherWorkspaceKey,
    ]) {
      queryClient.setQueryData(queryKey, { seeded: true });
    }

    await invalidateDeletedEntityQueries({
      queryClient,
      workspaceId: "workspace-1",
      entityIds: ["entity-1"],
    });

    expect(queryClient.getQueryState(entityDetailKey)?.isInvalidated).toBe(
      true,
    );
    expect(queryClient.getQueryState(untouchedEntityKey)?.isInvalidated).toBe(
      false,
    );
    expect(queryClient.getQueryState(collectionKey)?.isInvalidated).toBe(true);
    expect(
      queryClient.getQueryState(entitiesKeys.folders("workspace-1"))
        ?.isInvalidated,
    ).toBe(true);
    expect(
      queryClient.getQueryState(entitiesKeys.files("workspace-1"))
        ?.isInvalidated,
    ).toBe(true);
    expect(queryClient.getQueryState(taskDetailKey)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(overviewKey)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(otherWorkspaceKey)?.isInvalidated).toBe(
      false,
    );
  });
});
