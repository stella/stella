import { QueryClient, QueryObserver } from "@tanstack/react-query";
import type { QueryKey } from "@tanstack/react-query";
import { describe, expect, test } from "bun:test";

import { inboxKeys } from "@/lib/inbox/queries";
import { knowledgeKeys } from "@/lib/knowledge/queries";
import { notificationsOptions } from "@/lib/notification-queries";
import { flowRunsQueryRoot } from "@/lib/resource-query-roots.logic";
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
      ...(featureId === "flows"
        ? [
            [...flowRunsQueryRoot("matter-a"), "run-a"],
            knowledgeKeys.flows.detail(CALLER.organizationId, "flow-a"),
          ]
        : []),
    ];
    const otherCaller = notificationsOptions({
      organizationId: "org-b",
      userId: "user-b",
    }).queryKey;
    for (const queryKey of derivedKeys) {
      cachePrivatePayload(queryClient, queryKey);
      expect(queryClient.getQueryData(queryKey)).toBeDefined();
      expect(
        queryClient.getQueryCache().find({ queryKey, exact: true })?.isActive(),
      ).toBe(false);
    }
    cachePrivatePayload(queryClient, otherCaller);
    queryClient.setQueryData(["unrelated-public-data"], "keep");

    await resetFeatureEnrolmentCache({ queryClient, featureId, ...CALLER });

    for (const queryKey of derivedKeys) {
      expect(queryClient.getQueryData(queryKey)).toBeUndefined();
      expect(
        queryClient.getQueryCache().find({ queryKey, exact: true }),
      ).toBeUndefined();
    }
    expect(queryClient.getQueryCache().getAll()).toHaveLength(2);
    expect(queryClient.getQueryData(otherCaller)).toBeDefined();
    expect(queryClient.getQueryData(["unrelated-public-data"])).toBe("keep");
    queryClient.clear();
  };
  test("flows access changes clear all cached work projections", () =>
    assertWorkProjectionReset("flows"));
  test("signals access changes clear all cached work projections", () =>
    assertWorkProjectionReset("signals"));

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
      queryFn: () =>
        access === "granted"
          ? previousRead.promise
          : Promise.reject(new Error("refresh unavailable")),
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
    expect(queryClient.getQueryData(queryKey)).toBeUndefined();
    unsubscribe();
    queryClient.clear();
  });
});
