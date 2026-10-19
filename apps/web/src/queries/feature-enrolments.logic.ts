import { matchQuery } from "@tanstack/react-query";
import type { Query, QueryClient, QueryKey } from "@tanstack/react-query";

import { timeTimersKeys } from "@/features/time-timers/queries";
import type { api } from "@/lib/api";
import { inboxKeys } from "@/lib/inbox/queries";
import { knowledgeKeys } from "@/lib/knowledge/queries";
import { notificationsOptions } from "@/lib/notification-queries";
import {
  calendarTasksQueryRoot,
  expensesQueryRoot,
  flowRunsQueryRoot,
  invoicesQueryRoot,
  ratesQueryRoot,
  tasksQueryRoot,
  timeEntriesQueryRoot,
} from "@/lib/resource-query-roots.logic";
import { searchKeys } from "@/lib/search";
import { workspacesKeys } from "@/lib/workspaces/queries.logic";
import { entitiesKeys } from "@/lib/workspaces/queries/entities.logic";
import {
  entityViewKeys,
  entityViewsOptions,
} from "@/lib/workspaces/queries/entity-views";
import { myWorkKeys } from "@/lib/workspaces/queries/my-work";
import { viewsRootKey } from "@/lib/workspaces/queries/views.logic";

export type SelfServeFeatureId = NonNullable<
  Awaited<
    ReturnType<
      (typeof api)["organization-settings"]["feature-enrolments"]["get"]
    >
  >["data"]
>["features"][number]["featureId"];

export type FeatureEnrolmentsCaller = {
  userId: string;
  organizationId: string;
};

type ResetFeatureEnrolmentCacheOptions = FeatureEnrolmentsCaller & {
  featureId: SelfServeFeatureId;
  queryClient: QueryClient;
};

export const resetFeatureEnrolmentCache = async ({
  featureId,
  organizationId,
  queryClient,
  userId,
}: ResetFeatureEnrolmentCacheOptions) => {
  // Matter keys have no caller segment: reset every cached matter projection,
  // including inactive inspectors, when this visitor's access changes.
  const projections = [
    tasksQueryRoot("").slice(0, 1),
    calendarTasksQueryRoot("").slice(0, 1),
    entitiesKeys.all("").slice(0, 1),
    viewsRootKey("").slice(0, 1),
    workspacesKeys.all,
    myWorkKeys.all,
    inboxKeys.all(organizationId, userId),
    entityViewKeys.all(organizationId, userId),
    entityViewsOptions(organizationId, userId).queryKey,
    notificationsOptions({ organizationId, userId }).queryKey,
    searchKeys.owner({ organizationId, userId }),
  ];
  const featureKeys = {
    flows: [
      flowRunsQueryRoot("").slice(0, 1),
      knowledgeKeys.flows.all(organizationId),
    ],
    signals: [inboxKeys.detail(organizationId, userId, "").slice(0, -1)],
    "time-billing": [
      timeEntriesQueryRoot("").slice(0, 1),
      expensesQueryRoot("").slice(0, 1),
      invoicesQueryRoot("").slice(0, 1),
      ratesQueryRoot("").slice(0, 1),
      timeTimersKeys.all(organizationId, userId),
    ],
  } as const satisfies Record<SelfServeFeatureId, readonly QueryKey[]>;
  const keys = [...projections, ...featureKeys[featureId]];

  await Promise.all(
    keys.map(async (queryKey) => await queryClient.cancelQueries({ queryKey })),
  );
  const queries = queryClient
    .getQueryCache()
    .getAll()
    .filter((query) =>
      keys.some((queryKey) => matchQuery({ queryKey }, query)),
    );
  const placeholderObservers = queries.flatMap((query) =>
    query.observers
      .filter((observer) => observer.options.placeholderData !== undefined)
      .map((observer) => ({ observer, options: observer.options })),
  );
  // Observers memoize already rendered placeholders independently of query
  // state. Clear that memo before resetting its source, then restore normal
  // placeholder behavior against the cleared source queries.
  for (const { observer, options } of placeholderObservers) {
    observer.setOptions({
      ...options,
      placeholderData: (
        _previousData: unknown,
        previousQuery: Query | undefined,
      ) => {
        // An observer can retain its source after that inactive query leaves
        // the cache. Reset that source through the callback's public argument.
        if (
          previousQuery?.state.data !== undefined &&
          keys.some((queryKey) => matchQuery({ queryKey }, previousQuery))
        ) {
          previousQuery.reset();
        }
        return undefined;
      },
    });
  }
  // Clear observer state before a failed refresh can retain stale metadata.
  // Reset does not start a read: feature readers unmount as admission changes.
  for (const query of queries) {
    query.reset();
  }
  for (const { observer, options } of placeholderObservers) {
    observer.setOptions(options);
  }
  for (const queryKey of keys) {
    queryClient.removeQueries({ queryKey, type: "inactive" });
  }
  const featureOnlyKeys = Object.values(featureKeys).flat();
  await queryClient.refetchQueries({
    type: "active",
    predicate: (query) =>
      projections.some((queryKey) => matchQuery({ queryKey }, query)) &&
      !featureOnlyKeys.some((queryKey) => matchQuery({ queryKey }, query)),
  });
};
