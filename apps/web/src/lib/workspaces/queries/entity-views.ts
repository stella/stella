import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";

import type { EntityViewScope } from "@/components/entity-views/types";
import { api } from "@/lib/api";
import { unwrapEden } from "@/lib/errors/api";
import { stringCursorSeed } from "@/lib/infinite-query";
import { toSafeId } from "@/lib/safe-id";
import type { ViewLayout } from "@/lib/types";
import { toWorkspaceEntity } from "@/lib/workspaces/queries/entities";
import { myWorkKeys } from "@/lib/workspaces/queries/my-work";

export const entityViewKeys = {
  all: (organizationId: string) =>
    [...myWorkKeys.all, "entity-views", organizationId] as const,
};

type EntityViewRowsOptions = {
  organizationId: string;
  scope: EntityViewScope;
  layout: ViewLayout;
};

export const entityViewRowsOptions = ({
  organizationId,
  scope,
  layout,
}: EntityViewRowsOptions) =>
  infiniteQueryOptions({
    queryKey: [
      ...entityViewKeys.all(organizationId),
      scope,
      layout.filters,
      layout.sorts,
    ],
    initialPageParam: stringCursorSeed(),
    queryFn: async ({ signal, pageParam }) => {
      const page = unwrapEden(
        await api["entity-views"]["query-window"].post(
          {
            scope:
              scope.type === "matter"
                ? {
                    type: "matter",
                    matterId: toSafeId<"workspace">(scope.matterId),
                  }
                : { type: "organization" },
            filters: layout.filters,
            sorts: layout.sorts,
            includeAssignees: true,
            fieldMode: "full",
            ...(pageParam ? { cursor: pageParam } : {}),
          },
          { fetch: { signal } },
        ),
      );
      return {
        ...page,
        items: page.items.map((item) => ({
          type: "entity" as const,
          entity: toWorkspaceEntity(item),
          workspaceId: item.workspaceId,
          workspaceName: item.workspaceName,
        })),
      };
    },
    getNextPageParam: ({ nextCursor }) => nextCursor ?? undefined,
    staleTime: 60_000,
  });

export const entityViewsOptions = (organizationId: string) =>
  queryOptions({
    queryKey: ["entity-view-layouts", organizationId],
    queryFn: async ({ signal }) =>
      unwrapEden(await api["entity-views"].get({ fetch: { signal } })),
  });
