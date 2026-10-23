import {
  InfiniteQueryObserver,
  QueryClient,
  QueryObserver,
  hashKey,
} from "@tanstack/react-query";
import type { QueryKey } from "@tanstack/react-query";
import { expect, test } from "bun:test";

import {
  REALTIME_EVENT_TYPE,
  RESOURCE_TYPE,
  RESOURCE_CHANGE_TYPE,
} from "@stll/api-contract";
import type { WorkspaceRealtimeEvent } from "@stll/api-contract";

import { toSafeId } from "@/lib/safe-id";
import {
  getWorkspaceRealtimeQueryActions,
  getWorkspaceReconnectQueryActions,
  WORKSPACE_REALTIME_QUERY_ACTION,
} from "@/lib/workspace-realtime";
import type { WorkspaceRealtimeQueryAction } from "@/lib/workspace-realtime";
import { createWorkspaceQueryActionBatch } from "@/lib/workspace-sse";
import {
  invalidateDeletedEntityQueries,
  invalidateRenamedEntityQueries,
} from "@/lib/workspaces/mutations/entities.logic";
import * as entityQueries from "@/lib/workspaces/queries/entities";
import { entitiesKeys } from "@/lib/workspaces/queries/entities.logic";

const WORKSPACE_ID = "00000000-0000-4000-8000-000000000001";
const ENTITY_ID = toSafeId<"entity">("00000000-0000-4000-8000-000000000002");
const BURST_SIZE = 20;
const resource = { type: RESOURCE_TYPE.ENTITY, id: ENTITY_ID } as const;

const entityMutationBudgetCases = {
  useDeleteEntities: async ({
    queryClient,
    workspaceId,
    entityId,
  }: Parameters<typeof invalidateRenamedEntityQueries>[0]) =>
    await invalidateDeletedEntityQueries({
      queryClient,
      workspaceId,
      entityIds: [entityId],
    }),
  useRenameEntity: invalidateRenamedEntityQueries,
} as const;

const viewKey = { workspaceId: WORKSPACE_ID, filters: [], sorts: [] };
const groupKey = {
  ...viewKey,
  groupByPropertyId: "_status",
  groupValue: "todo",
};
const compareEventTypes = (left: string, right: string) => {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
};
const VIEW_QUERY_KEYS = {
  entitiesOptions: entityQueries.entitiesOptions(viewKey).queryKey,
  entitiesWindowOptions: entityQueries.entitiesWindowOptions(viewKey).queryKey,
  filesystemEntitiesOptions:
    entityQueries.filesystemEntitiesOptions(viewKey).queryKey,
  kanbanGroupOptions: entityQueries.kanbanGroupOptions(groupKey).queryKey,
  groupCountsOptions: entityQueries.groupCountsOptions(groupKey).queryKey,
  entityOptions: entityQueries.entityOptions(WORKSPACE_ID, ENTITY_ID).queryKey,
  entitySummariesOptions:
    entityQueries.entitySummariesOptions(WORKSPACE_ID).queryKey,
  entitySummariesCountOptions:
    entityQueries.entitySummariesCountOptions(WORKSPACE_ID).queryKey,
  workspaceFoldersOptions:
    entityQueries.workspaceFoldersOptions(WORKSPACE_ID).queryKey,
  workspaceFilesOptions:
    entityQueries.workspaceFilesOptions(WORKSPACE_ID).queryKey,
} satisfies Record<
  Exclude<
    Extract<keyof typeof entityQueries, `${string}Options`>,
    `use${string}`
  >,
  QueryKey
>;

// Each branch is checked against its producer type, including events that
// deliberately do no query work.
const EVENT_CASES = {
  [REALTIME_EVENT_TYPE.RESOURCE_UPDATED]: {
    type: REALTIME_EVENT_TYPE.RESOURCE_UPDATED,
    resource,
  },
  [REALTIME_EVENT_TYPE.RESOURCE_DELETED]: {
    type: REALTIME_EVENT_TYPE.RESOURCE_DELETED,
    resource,
  },
  [REALTIME_EVENT_TYPE.RESOURCES_CHANGED]: {
    type: REALTIME_EVENT_TYPE.RESOURCES_CHANGED,
    changes: [{ change: RESOURCE_CHANGE_TYPE.UPDATED, resource }],
  },
  [REALTIME_EVENT_TYPE.RESOURCE_SET_UPDATED]: {
    type: REALTIME_EVENT_TYPE.RESOURCE_SET_UPDATED,
    resourceType: RESOURCE_TYPE.ENTITY,
  },
  [REALTIME_EVENT_TYPE.FLOW_RUN_UPDATE]: {
    type: REALTIME_EVENT_TYPE.FLOW_RUN_UPDATE,
    data: { runId: "run", status: "running", currentStepIndex: 0, steps: [] },
  },
  [REALTIME_EVENT_TYPE.WORKFLOW_EXTRACTION_PREVIEW]: {
    type: REALTIME_EVENT_TYPE.WORKFLOW_EXTRACTION_PREVIEW,
    data: {
      entityId: ENTITY_ID,
      entityVersionId: "version",
      propertyId: "property",
      answer: null,
      status: "streaming",
    },
  },
} satisfies {
  [Type in WorkspaceRealtimeEvent["type"]]: Extract<
    WorkspaceRealtimeEvent,
    { type: Type }
  >;
};

const settle = async () =>
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });

const createMeasuredClient = () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  const starts = new Map<string, number>();
  const unsubscribe = client.getQueryCache().subscribe((event) => {
    if (event.type === "updated" && event.action.type === "fetch") {
      starts.set(
        event.query.queryHash,
        (starts.get(event.query.queryHash) ?? 0) + 1,
      );
    }
  });
  return {
    client,
    starts,
    close: () => {
      unsubscribe();
      client.clear();
    },
  };
};

const observe = (client: QueryClient, queryKey: QueryKey, rowCount: number) => {
  client.setQueryData(
    queryKey,
    Array.from({ length: rowCount }, (_, id) => id),
  );
  const observer = new QueryObserver(client, {
    queryKey,
    queryFn: async ({ queryKey: fetchedKey }) => fetchedKey,
  });
  return observer.subscribe(() => undefined);
};

test("ending a stream applies its pending cache actions once", () => {
  const applied: WorkspaceRealtimeQueryAction[] = [];
  let cancellations = 0;
  const batch = createWorkspaceQueryActionBatch(
    (actions) => {
      applied.push(...actions);
    },
    () => () => {
      cancellations += 1;
    },
  );
  const actions = getWorkspaceRealtimeQueryActions(
    EVENT_CASES[REALTIME_EVENT_TYPE.RESOURCE_UPDATED],
    WORKSPACE_ID,
  );
  batch.add(actions);
  batch.add(actions);
  batch.cancel();
  batch.cancel();
  expect(applied).toEqual(actions);
  expect(cancellations).toBe(1);
});

type MeasureBurstOptions = {
  event: WorkspaceRealtimeEvent;
  rowCount: number;
  mode: "immediate" | "batched";
};
const measureBurst = async ({ event, rowCount, mode }: MeasureBurstOptions) => {
  const { client, starts, close } = createMeasuredClient();
  // Observe every cache scope used by the stream, including unrelated views.
  // Cache events count work regardless of which observer starts it.
  const keys = new Map(
    getWorkspaceReconnectQueryActions(WORKSPACE_ID).map((action) => [
      hashKey(action.queryKey),
      action.queryKey,
    ]),
  );
  keys.set(
    hashKey(entitiesKeys.detail(WORKSPACE_ID, ENTITY_ID)),
    entitiesKeys.detail(WORKSPACE_ID, ENTITY_ID),
  );
  const subscriptions = [...keys.values()].map((key) =>
    observe(client, key, rowCount),
  );
  const invalidations = new Map<string, number>();
  const scheduled: { current: (() => void) | null } = { current: null };
  const apply = (actions: WorkspaceRealtimeQueryAction[]) => {
    for (const action of actions) {
      switch (action.type) {
        case WORKSPACE_REALTIME_QUERY_ACTION.INVALIDATE: {
          const hash = hashKey(action.queryKey);
          invalidations.set(hash, (invalidations.get(hash) ?? 0) + 1);
          void client.invalidateQueries({ queryKey: action.queryKey });
          break;
        }
        case WORKSPACE_REALTIME_QUERY_ACTION.REMOVE_PREFIX:
          client.removeQueries({ queryKey: action.queryKey });
          break;
        default:
          action satisfies never;
      }
    }
  };
  const batch = createWorkspaceQueryActionBatch(apply, (callback) => {
    scheduled.current = callback;
    return () => {
      scheduled.current = null;
    };
  });
  for (let index = 0; index < BURST_SIZE; index += 1) {
    const actions = getWorkspaceRealtimeQueryActions(event, WORKSPACE_ID);
    if (mode === "immediate") {
      apply(actions);
    } else {
      batch.add(actions);
    }
    await settle();
  }
  scheduled.current?.();
  await settle();
  const result = {
    fetches: [...starts.values()].reduce((sum, count) => sum + count, 0),
    starts: [...starts.values()],
    invalidations: [...invalidations.values()],
  };
  batch.cancel();
  for (const unsubscribe of subscriptions) {
    unsubscribe();
  }
  close();
  return result;
};

test("live-update cases cover every event branch in the cache adapter", async () => {
  const source = await Bun.file(
    new URL("workspace-realtime.ts", import.meta.url),
  ).text();
  const branches = [
    ...source.matchAll(/case REALTIME_EVENT_TYPE\.(\w+):/gu),
  ].map((match) => {
    const name = match.at(1);
    const entry = Object.entries(REALTIME_EVENT_TYPE).find(
      ([key]) => key === name,
    );
    expect(entry).toBeDefined();
    if (!entry) {
      throw new Error(`Missing realtime event type for ${name ?? "unknown"}`);
    }
    return entry[1];
  });
  expect(Object.keys(EVENT_CASES).toSorted(compareEventTypes)).toEqual(
    branches.toSorted(compareEventTypes),
  );
});

for (const event of Object.values(EVENT_CASES)) {
  test(`${event.type}: twenty updates touch each query once at N and 10N`, async () => {
    const before = await measureBurst({
      event,
      rowCount: 1000,
      mode: "immediate",
    });
    const atN = await measureBurst({ event, rowCount: 100, mode: "batched" });
    const after = await measureBurst({
      event,
      rowCount: 1000,
      mode: "batched",
    });
    expect(after).toEqual(atN);
    for (const count of after.starts) {
      expect(count).toBe(1);
    }
    for (const count of after.invalidations) {
      expect(count).toBe(1);
    }
    expect(before.fetches).toBe(after.fetches * BURST_SIZE);
    console.info(
      `${event.type} at 10N: ${before.fetches} -> ${after.fetches} fetch starts`,
    );
  });
}

test("stream-covered query owners declare no periodic refetches", async () => {
  const owners = [
    "workspaces/queries/flow-runs.ts",
    "workspaces/queries/workspace.ts",
    "../components/inspector/use-file-tab-entity.ts",
  ];
  for (const owner of owners) {
    const source = await Bun.file(new URL(owner, import.meta.url)).text();
    expect([...source.matchAll(/\brefetchInterval\s*:/gu)]).toHaveLength(0);
  }
});

test("entity query cases cover every exported query factory", () => {
  expect(
    Object.keys(entityQueries)
      .filter((name) => name.endsWith("Options") && !name.startsWith("use"))
      .toSorted(),
  ).toEqual(Object.keys(VIEW_QUERY_KEYS).toSorted());
});

type MeasureMutationOptions = {
  mutate: (
    options: Parameters<typeof entityMutationBudgetCases.useRenameEntity>[0],
  ) => Promise<unknown>;
  detailCount: number;
};
const measureMutation = async ({
  mutate,
  detailCount,
}: MeasureMutationOptions) => {
  const { client, starts, close } = createMeasuredClient();
  const keys = new Map<string, QueryKey>();
  for (const key of Object.values(VIEW_QUERY_KEYS)) {
    keys.set(hashKey(key), key);
  }
  for (let index = 1; index < detailCount; index += 1) {
    const key = entitiesKeys.detail(WORKSPACE_ID, `entity-${index}`);
    keys.set(hashKey(key), key);
  }
  const subscriptions = [...keys.values()].map((key) =>
    observe(client, key, detailCount),
  );
  await mutate({
    queryClient: client,
    workspaceId: WORKSPACE_ID,
    entityId: ENTITY_ID,
  });
  const total = [...starts.values()].reduce((sum, count) => sum + count, 0);
  const touched = [...starts.keys()].toSorted();
  for (const unsubscribe of subscriptions) {
    unsubscribe();
  }
  close();
  return { total, touched };
};

for (const [name, mutate] of Object.entries(entityMutationBudgetCases)) {
  test(`${name}: refetches stay bounded with 10N active entity details`, async () => {
    const before = await measureMutation({
      mutate: async ({ queryClient, workspaceId }) =>
        await queryClient.invalidateQueries({
          queryKey: entitiesKeys.all(workspaceId),
        }),
      detailCount: 1000,
    });
    const atN = await measureMutation({ mutate, detailCount: 100 });
    const after = await measureMutation({ mutate, detailCount: 1000 });
    expect(after.total).toBe(atN.total);
    expect(after.touched).toEqual(
      [...new Set(Object.values(VIEW_QUERY_KEYS).map(hashKey))].toSorted(),
    );
    expect(after.total).toBe(Object.keys(VIEW_QUERY_KEYS).length);
    expect(before.total).toBe(999 + Object.keys(VIEW_QUERY_KEYS).length);
    console.info(
      `${name} at 10N: ${before.total} -> ${after.total} fetch starts`,
    );
  });
}

const infiniteEntityViewCases = {
  window: (client: QueryClient) =>
    new InfiniteQueryObserver(client, {
      ...entityQueries.entitiesWindowOptions(viewKey),
      queryFn: async ({ pageParam }) => ({
        entities: [],
        nextCursor: String(Number(pageParam ?? 0) + 1),
        limit: 200,
      }),
    }),
  kanban: (client: QueryClient) =>
    new InfiniteQueryObserver(client, {
      ...entityQueries.kanbanGroupOptions(groupKey),
      queryFn: async ({ pageParam }) => ({
        entities: [],
        nextCursor: String(Number(pageParam ?? 0) + 1),
        limit: 200,
      }),
    }),
};

for (const [name, createObserver] of Object.entries(infiniteEntityViewCases)) {
  test(`${name}: infinite entity views retain at most three refetchable pages at 10N`, async () => {
    const { client, close } = createMeasuredClient();
    const observer = createObserver(client);
    const unsubscribe = observer.subscribe(() => undefined);
    await observer.refetch();
    for (let index = 1; index < 30; index += 1) {
      await observer.fetchNextPage();
    }
    expect(observer.getCurrentResult().data?.pages).toHaveLength(3);
    unsubscribe();
    close();
  });
}
