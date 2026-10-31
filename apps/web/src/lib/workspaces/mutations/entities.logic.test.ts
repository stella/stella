import { QueryClient } from "@tanstack/react-query";
import type { QueryKey } from "@tanstack/react-query";
import { describe, expect, test } from "bun:test";

import {
  invalidateDeletedEntityQueries,
  invalidateRenamedEntityQueries,
} from "@/lib/workspaces/mutations/entities.logic";
import { workspacesKeys } from "@/lib/workspaces/queries.logic";
import { entitiesKeys } from "@/lib/workspaces/queries/entities.logic";
import { taskKeys } from "@/lib/workspaces/queries/tasks.logic";

const WORKSPACE = "00000000-0000-4000-8000-0000000000a1";
const OTHER_WORKSPACE = "00000000-0000-4000-8000-0000000000a2";
const ENTITY = "00000000-0000-4000-8000-0000000000e1";
const OTHER_ENTITY = "00000000-0000-4000-8000-0000000000e2";

const seed = (queryClient: QueryClient, keys: readonly QueryKey[]) => {
  for (const queryKey of keys) {
    queryClient.setQueryData(queryKey, { seeded: true });
  }
};

const isInvalidated = (queryClient: QueryClient, queryKey: QueryKey) =>
  queryClient.getQueryState(queryKey)?.isInvalidated;

// Keys spanning many entities, including aggregates no collection list names.
const collectionKeys = [
  entitiesKeys.window({ workspaceId: WORKSPACE, filters: [], sorts: [] }),
  entitiesKeys.folders(WORKSPACE),
  entitiesKeys.files(WORKSPACE),
  entitiesKeys.summariesCount(WORKSPACE),
  workspacesKeys.activityAll(WORKSPACE),
];

describe("deleted entity cache invalidation", () => {
  test("marks the entity, every collection, task and overview queries stale", async () => {
    const queryClient = new QueryClient();
    const entityDetailKey = entitiesKeys.detail(WORKSPACE, ENTITY);
    const entityVersionsKey = entitiesKeys.versions(WORKSPACE, ENTITY);
    const untouchedEntityKey = entitiesKeys.detail(WORKSPACE, OTHER_ENTITY);
    const taskDetailKey = taskKeys.detail(WORKSPACE, ENTITY);
    const overviewKey = workspacesKeys.overview(WORKSPACE);
    const otherWorkspaceKey = entitiesKeys.detail(OTHER_WORKSPACE, ENTITY);
    seed(queryClient, [
      entityDetailKey,
      entityVersionsKey,
      untouchedEntityKey,
      ...collectionKeys,
      taskDetailKey,
      overviewKey,
      otherWorkspaceKey,
    ]);

    await invalidateDeletedEntityQueries({
      queryClient,
      workspaceId: WORKSPACE,
      entityIds: [ENTITY],
    });

    expect(isInvalidated(queryClient, entityDetailKey)).toBe(true);
    expect(isInvalidated(queryClient, entityVersionsKey)).toBe(true);
    expect(isInvalidated(queryClient, untouchedEntityKey)).toBe(false);
    for (const key of collectionKeys) {
      expect({ key, invalidated: isInvalidated(queryClient, key) }).toEqual({
        key,
        invalidated: true,
      });
    }
    expect(isInvalidated(queryClient, taskDetailKey)).toBe(true);
    expect(isInvalidated(queryClient, overviewKey)).toBe(true);
    expect(isInvalidated(queryClient, otherWorkspaceKey)).toBe(false);
  });
});

describe("renamed entity cache invalidation", () => {
  test("marks the entity and every collection stale, never other entities", async () => {
    const queryClient = new QueryClient();
    const entityDetailKey = entitiesKeys.detail(WORKSPACE, ENTITY);
    const untouchedEntityKey = entitiesKeys.detail(WORKSPACE, OTHER_ENTITY);
    seed(queryClient, [entityDetailKey, untouchedEntityKey, ...collectionKeys]);

    await invalidateRenamedEntityQueries({
      queryClient,
      workspaceId: WORKSPACE,
      entityId: ENTITY,
    });

    expect(isInvalidated(queryClient, entityDetailKey)).toBe(true);
    expect(isInvalidated(queryClient, untouchedEntityKey)).toBe(false);
    for (const key of collectionKeys) {
      expect({ key, invalidated: isInvalidated(queryClient, key) }).toEqual({
        key,
        invalidated: true,
      });
    }
  });
});
