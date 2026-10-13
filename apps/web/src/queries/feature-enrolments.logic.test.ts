import { QueryClient, QueryObserver } from "@tanstack/react-query";
import type { QueryKey } from "@tanstack/react-query";
import { describe, expect, test } from "bun:test";

import { inboxKeys } from "@/lib/inbox/queries";
import { knowledgeKeys } from "@/lib/knowledge/queries";
import { notificationsOptions } from "@/lib/notification-queries";
import {
  calendarTasksQueryRoot,
  flowRunsQueryRoot,
} from "@/lib/resource-query-roots.logic";
import { searchFacetOptions, searchKeys } from "@/lib/search";
import { workspacesKeys } from "@/lib/workspaces/queries.logic";
import { entitiesKeys } from "@/lib/workspaces/queries/entities.logic";
import {
  entityViewKeys,
  entityViewsOptions,
} from "@/lib/workspaces/queries/entity-views";
import { taskKeys } from "@/lib/workspaces/queries/tasks.logic";
import { viewsRootKey } from "@/lib/workspaces/queries/views.logic";
import { resetFeatureEnrolmentCache } from "@/queries/feature-enrolments.logic";
import type { SelfServeFeatureId } from "@/queries/feature-enrolments.logic";

const CALLER = { organizationId: "org-a", userId: "user-a" };

const cachePrivatePayload = (queryClient: QueryClient, queryKey: QueryKey) =>
  queryClient.setQueryData(queryKey, "feature-derived private payload");

describe("feature enrollment cache reconciliation", () => {
  const assertWorkProjectionReset = async (featureId: SelfServeFeatureId) => {
    const queryClient = new QueryClient();
    const derivedKeys = [
      [...calendarTasksQueryRoot("matter-a"), "range", "2026-10-08"],
      taskKeys.detail("matter-a", "task-a"),
      taskKeys.detail("matter-b", "task-b"),
      entitiesKeys.detail("matter-a", "task-a"),
      [...entitiesKeys.detail("matter-a", "task-a"), "links"],
      viewsRootKey("matter-a"),
      workspacesKeys.overview("matter-a"),
      inboxKeys.all(CALLER.organizationId, CALLER.userId),
      inboxKeys.count(CALLER.organizationId, CALLER.userId, "2026-10-08"),
      inboxKeys.detail(CALLER.organizationId, CALLER.userId, "signal-a"),
      entityViewKeys.all(CALLER.organizationId, CALLER.userId),
      [
        ...entityViewKeys.all(CALLER.organizationId, CALLER.userId),
        "matter-a",
        "open",
      ],
      entityViewsOptions(CALLER.organizationId, CALLER.userId).queryKey,
      notificationsOptions(CALLER).queryKey,
      ...["query", "preview", "facet", "recent-file-preview-field"].map(
        (projection) => [...searchKeys.owner(CALLER), projection, "item-a"],
      ),
      ...(featureId === "flows"
        ? [
            [...flowRunsQueryRoot("matter-a"), "run-a"],
            knowledgeKeys.flows.detail(CALLER.organizationId, "flow-a"),
          ]
        : []),
    ];
    const otherCaller = notificationsOptions({
      organizationId: CALLER.organizationId,
      userId: "user-b",
    }).queryKey;
    for (const queryKey of derivedKeys) {
      cachePrivatePayload(queryClient, queryKey);
      expect(
        queryClient.getQueryCache().find({ queryKey, exact: true })?.state.data,
      ).toBeDefined();
      expect(
        queryClient.getQueryCache().find({ queryKey, exact: true })?.isActive(),
      ).toBe(false);
    }
    cachePrivatePayload(queryClient, otherCaller);
    queryClient.setQueryData(["unrelated-public-data"], "keep");
    const otherSearchCaller = searchKeys.owner({ ...CALLER, userId: "user-b" });
    queryClient.setQueryData(otherSearchCaller, "keep search");

    await resetFeatureEnrolmentCache({ queryClient, featureId, ...CALLER });

    for (const queryKey of derivedKeys) {
      expect(
        queryClient.getQueryCache().find({ queryKey, exact: true })?.state.data,
      ).toBeUndefined();
      expect(
        queryClient.getQueryCache().find({ queryKey, exact: true }),
      ).toBeUndefined();
    }
    expect(queryClient.getQueryCache().getAll()).toHaveLength(3);
    expect(queryClient.getQueryData(otherSearchCaller)).toBe("keep search");
    expect(
      queryClient.getQueryCache().find({ queryKey: otherCaller, exact: true })
        ?.state.data,
    ).toBeDefined();
    expect(
      queryClient
        .getQueryCache()
        .find({ queryKey: ["unrelated-public-data"], exact: true })?.state.data,
    ).toBe("keep");
    queryClient.clear();
  };
  test("flows access changes clear all cached work projections", async () =>
    await assertWorkProjectionReset("flows"));
  test("signals access changes clear all cached work projections", async () =>
    await assertWorkProjectionReset("signals"));

  test("an open task clears linked review data even when its refresh fails", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    const queryKey = taskKeys.detail("matter-a", "task-a");
    const previousRead = Promise.withResolvers<string>();
    let access = "granted";
    queryClient.setQueryData(queryKey, "linked review before opt-out");
    const observer = new QueryObserver(queryClient, {
      queryKey,
      queryFn: async () =>
        await (access === "granted"
          ? previousRead.promise
          : Promise.reject(new Error("refresh unavailable"))),
    });
    const unsubscribe = observer.subscribe(() => undefined);
    expect(observer.getCurrentResult().data).toBe(
      "linked review before opt-out",
    );
    const pendingRead = observer.refetch();
    expect(queryClient.isFetching({ queryKey })).toBe(1);
    access = "revoked";

    await resetFeatureEnrolmentCache({
      queryClient,
      featureId: "flows",
      ...CALLER,
    });
    previousRead.resolve("late linked review from before opt-out");
    await pendingRead;

    expect(observer.getCurrentResult().data).toBeUndefined();
    expect(observer.getCurrentResult().status).toBe("error");
    expect(
      queryClient.getQueryCache().find({ queryKey, exact: true })?.state.data,
    ).toBeUndefined();
    unsubscribe();
    queryClient.clear();
  });

  test.each(["query", "preview", "facet", "recent-file-preview-field"])(
    "opt-out clears an active search %s before a failed refresh and cancels its late response",
    async (projection) => {
      const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false, staleTime: Infinity } },
      });
      const queryKey = [...searchKeys.owner(CALLER), projection, "item-a"];
      const read = Promise.withResolvers<string>();
      let reads = 0;
      queryClient.setQueryData(queryKey, "feature projection");
      const observer = new QueryObserver(queryClient, {
        queryKey,
        queryFn: async () => {
          reads += 1;
          if (reads > 1) {
            throw new Error("refresh unavailable");
          }
          return await read.promise;
        },
      });
      const unsubscribe = observer.subscribe(() => undefined);
      const pendingRead = observer.refetch();
      expect(queryClient.isFetching({ queryKey })).toBe(1);

      await resetFeatureEnrolmentCache({
        queryClient,
        featureId: "flows",
        ...CALLER,
      });
      read.resolve("late feature projection");
      await pendingRead;

      expect(reads).toBe(2);
      expect(observer.getCurrentResult().data).toBeUndefined();
      expect(queryClient.getQueryData(queryKey)).toBeUndefined();
      unsubscribe();
      queryClient.clear();
    },
  );

  test("ordinary readers refresh while signal readers stay cleared", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { staleTime: Infinity } },
    });
    const taskKey = taskKeys.detail("matter-a", "task-a");
    const signalKey = inboxKeys.detail(
      CALLER.organizationId,
      CALLER.userId,
      "signal-a",
    );
    let signalReads = 0;
    queryClient.setQueryData(taskKey, "work projection");
    queryClient.setQueryData(signalKey, "signal projection");
    const taskObserver = new QueryObserver(queryClient, {
      queryKey: taskKey,
      queryFn: async () => "ordinary work",
    });
    const signalObserver = new QueryObserver(queryClient, {
      queryKey: signalKey,
      queryFn: async () => {
        signalReads += 1;
        return "signal projection";
      },
    });
    const unsubscribeTask = taskObserver.subscribe(() => undefined);
    const unsubscribeSignal = signalObserver.subscribe(() => undefined);
    await resetFeatureEnrolmentCache({
      queryClient,
      featureId: "signals",
      ...CALLER,
    });
    expect(taskObserver.getCurrentResult().data).toBe("ordinary work");
    expect(signalObserver.getCurrentResult().data).toBeUndefined();
    expect(signalReads).toBe(0);
    unsubscribeTask();
    unsubscribeSignal();
    queryClient.clear();
  });

  test.each([false, true])(
    "search filter placeholders clear during opt-out and stay empty after a failed refresh (source removed=%s)",
    async (removeSource) => {
      const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false, staleTime: Infinity } },
      });
      const params = {
        ...CALLER,
        enabled: true,
        facet: "workspace",
        search: "",
        query: "work",
        workspaceIds: [],
        types: [],
        kinds: [],
        editedByUserIds: [],
        mimeTypes: [],
      } as const satisfies Parameters<typeof searchFacetOptions>[0];
      const original = searchFacetOptions(params);
      const filtered = searchFacetOptions({ ...params, search: "matter" });
      const payload = { buckets: [{ value: "matter-a", count: 1 }] };
      queryClient.setQueryData(original.queryKey, payload);
      const observer = new QueryObserver(queryClient, original);
      const unsubscribe = observer.subscribe(() => undefined);
      const read = Promise.withResolvers<typeof payload>();
      let reads = 0;
      observer.setOptions({
        ...filtered,
        queryFn: async () => {
          reads += 1;
          if (reads > 1) {
            throw new Error("refresh unavailable");
          }
          return await read.promise;
        },
      });
      expect(observer.getCurrentResult().isPlaceholderData).toBe(true);
      expect(observer.getCurrentResult().data).toEqual(payload);
      if (removeSource) {
        queryClient.removeQueries({ queryKey: original.queryKey, exact: true });
        expect(observer.getCurrentResult().data).toEqual(payload);
      }

      await resetFeatureEnrolmentCache({
        queryClient,
        featureId: "flows",
        ...CALLER,
      });
      read.resolve(payload);
      await read.promise;

      expect(reads).toBe(2);
      expect(observer.getCurrentResult().isPlaceholderData).toBe(false);
      expect(observer.getCurrentResult().data).toBeUndefined();
      expect(observer.getCurrentResult().status).toBe("error");
      unsubscribe();
      queryClient.clear();
    },
  );
});
