import type { QueryClient, QueryKey } from "@tanstack/react-query";

import { timeTimersKeys } from "@/features/time-timers/queries";
import type { api } from "@/lib/api";
import { inboxKeys } from "@/lib/inbox/queries";
import { knowledgeKeys } from "@/lib/knowledge/queries";
import { notificationsOptions } from "@/lib/notification-queries";
import {
  expensesQueryRoot,
  flowRunsQueryRoot,
  invoicesQueryRoot,
  ratesQueryRoot,
  tasksQueryRoot,
  timeEntriesQueryRoot,
} from "@/lib/resource-query-roots.logic";
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
    entitiesKeys.all("").slice(0, 1),
    viewsRootKey("").slice(0, 1),
    workspacesKeys.all,
    myWorkKeys.all,
    inboxKeys.all(organizationId, userId),
    entityViewKeys.all(organizationId, userId),
    entityViewsOptions(organizationId, userId).queryKey,
    notificationsOptions({ organizationId, userId }).queryKey,
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
  // Invalidation keeps the old payload if a refresh fails. Reset it first,
  // notifying active observers, so revoked metadata cannot remain on screen.
  await Promise.all(
    keys.map(async (queryKey) => await queryClient.resetQueries({ queryKey })),
  );
  for (const queryKey of keys) {
    queryClient.removeQueries({ queryKey, type: "inactive" });
  }
};
