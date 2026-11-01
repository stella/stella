import type { ReactNode } from "react";

import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type {
  QueryClient as QueryClientInstance,
  QueryFunctionContext,
  QueryKey,
} from "@tanstack/react-query";
import { afterAll, afterEach, expect, spyOn, test } from "bun:test";

import {
  REALTIME_EVENT_TYPE,
  RESOURCE_CHANGE_TYPE,
  RESOURCE_TYPE,
} from "@stll/api-contract";
import type { WorkspaceRealtimeEvent } from "@stll/api-contract";

import englishMessages from "@/i18n/langs/en.json";
import type { WorkspaceRealtimeQueryAction } from "@/lib/workspace-realtime";
import { unregisterDomEnvironment } from "@/test-dom-environment";

// The rename case drives the real rename hook, which renders under React.
GlobalRegistrator.register({ url: "http://localhost:3000" });
const { hashKey, QueryClient, QueryClientProvider, QueryObserver } =
  await import("@tanstack/react-query");
const { act, cleanup, renderHook } = await import("@testing-library/react");
const { IntlProvider } = await import("use-intl");
const { toSafeId } = await import("@/lib/safe-id");
const {
  getWorkspaceRealtimeQueryActions,
  getWorkspaceReconnectQueryActions,
  WORKSPACE_REALTIME_QUERY_ACTION,
} = await import("@/lib/workspace-realtime");
const { applyWorkspaceRealtimeQueryActions, createWorkspaceQueryActionBatch } =
  await import("@/lib/workspace-sse");
const { useRenameEntity } = await import("@/lib/workspaces/mutations/entities");
const { invalidateDeletedEntityQueries } =
  await import("@/lib/workspaces/mutations/entities.logic");
const entityQueries = await import("@/lib/workspaces/queries/entities");
const { entitiesKeys } =
  await import("@/lib/workspaces/queries/entities.logic");

afterEach(async () => {
  await act(async () => cleanup());
});
afterAll(async () => {
  await unregisterDomEnvironment();
});

const WORKSPACE_ID = "00000000-0000-4000-8000-000000000001";
const ENTITY_ID = toSafeId<"entity">("00000000-0000-4000-8000-000000000002");
const BURST_SIZE = 20;
const resource = { type: RESOURCE_TYPE.ENTITY, id: ENTITY_ID } as const;

const viewKey = { workspaceId: WORKSPACE_ID, filters: [], sorts: [] };
const groupKey = {
  ...viewKey,
  groupByPropertyId: "_status",
  groupValue: "todo",
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

// One case per realtime event kind: the mapped type fails to compile when a
// kind is added without a case, including kinds that do no query work.
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

const observe = (
  client: QueryClientInstance,
  queryKey: QueryKey,
  rowCount: number,
) => {
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
    { workspaceId: WORKSPACE_ID, queryClient: new QueryClient() },
  );
  batch.add(actions);
  batch.add(actions);
  batch.cancel();
  batch.cancel();
  expect(applied).toEqual(actions);
  expect(cancellations).toBe(1);
});

test("realtime entity bursts never abort an in-flight tree fetch", async () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  const key = VIEW_QUERY_KEYS.filesystemEntitiesOptions;
  const treeData = { entities: [], ancestorLinks: [], isFiltered: false };
  const resolvers: ((value: typeof treeData) => void)[] = [];
  let fetches = 0;
  let aborts = 0;
  client.setQueryData(key, treeData);
  // The query function counts fetches and aborts for the assertions; the
  // counters are instrumentation, not part of the query's identity.
  const queryFn = async ({ signal }: QueryFunctionContext) => {
    fetches += 1;
    signal.addEventListener("abort", () => {
      aborts += 1;
    });
    return await new Promise<typeof treeData>((resolve) => {
      resolvers.push(resolve);
    });
  };
  const observer = new QueryObserver(client, { queryKey: key, queryFn });
  const unsubscribe = observer.subscribe(() => undefined);
  void observer.refetch();
  const action = {
    type: WORKSPACE_REALTIME_QUERY_ACTION.INVALIDATE,
    queryKey: key,
  } as const;

  for (let index = 0; index < 50; index += 1) {
    applyWorkspaceRealtimeQueryActions(client, [action]);
  }
  expect(fetches).toBe(1);
  expect(aborts).toBe(0);
  resolvers[0]?.(treeData);
  await settle();
  expect(fetches).toBe(2);
  resolvers[1]?.(treeData);
  await settle();
  expect(fetches).toBe(2);
  expect(aborts).toBe(0);

  unsubscribe();
  client.clear();
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
    getWorkspaceReconnectQueryActions({
      workspaceId: WORKSPACE_ID,
      queryClient: client,
    }).map((action) => [hashKey(action.queryKey), action.queryKey]),
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
    const actions = getWorkspaceRealtimeQueryActions(event, {
      workspaceId: WORKSPACE_ID,
      queryClient: client,
    });
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

test("entity query cases cover every exported query factory", () => {
  expect(
    Object.keys(entityQueries)
      .filter((name) => name.endsWith("Options") && !name.startsWith("use"))
      .toSorted(),
  ).toEqual(Object.keys(VIEW_QUERY_KEYS).toSorted());
});

type EntityMutationOptions = {
  queryClient: QueryClientInstance;
  workspaceId: string;
  entityId: string;
};

// Commits a rename through the app's own rename hook; only the transport is
// answered here, so the cache work measured is exactly what a user's rename does.
const renameThroughHook = async ({
  queryClient,
  workspaceId,
  entityId,
}: EntityMutationOptions) => {
  const name = "Renamed.md";
  const transport = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async (input: string | URL | Request) => {
        const url = String(input instanceof Request ? input.url : input);
        if (!url.includes(`/entities/${workspaceId}/rename`)) {
          throw new Error(`Unexpected transport: ${url}`);
        }
        return Response.json({ entityId, name, file: null });
      },
      { preconnect: globalThis.fetch.preconnect },
    ),
  );
  const hook = renderHook(() => useRenameEntity(), {
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        <IntlProvider locale="en" messages={englishMessages} timeZone="UTC">
          {children}
        </IntlProvider>
      </QueryClientProvider>
    ),
  });
  try {
    await act(async () => {
      await hook.result.current.mutateAsync({ workspaceId, entityId, name });
    });
    expect(transport).toHaveBeenCalledTimes(1);
  } finally {
    hook.unmount();
    transport.mockRestore();
  }
};

// The cache consequences of the delete and rename mutations: delete through
// the function its hook calls, rename through the rename hook itself.
const entityMutationCases = {
  delete: async (options: EntityMutationOptions) =>
    await invalidateDeletedEntityQueries({
      queryClient: options.queryClient,
      workspaceId: options.workspaceId,
      entityIds: [options.entityId],
    }),
  rename: renameThroughHook,
};

// Other entities' detail keys carry real entity ids, distinct from ENTITY_ID.
const otherEntityId = (index: number) =>
  `00000000-0000-4000-9000-${String(index).padStart(12, "0")}`;

type MeasureMutationOptions = {
  mutate: (options: EntityMutationOptions) => Promise<unknown>;
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
    const key = entitiesKeys.detail(WORKSPACE_ID, otherEntityId(index));
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

for (const [name, mutate] of Object.entries(entityMutationCases)) {
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
