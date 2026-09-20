import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";
import { panic } from "better-result";

import { isTaskStatus } from "@stll/api-contract";
import { ENTITY_VIEW_ROW_KIND } from "@stll/api-contract/entity-views";

import { isProposalType } from "@/components/entity-views/types";
import type {
  EntityViewEntry,
  EntityViewScope,
  ProposalProjection,
} from "@/components/entity-views/types";
import { api } from "@/lib/api";
import { unwrapEden } from "@/lib/errors/api";
import type { InboxView } from "@/lib/inbox/queries";
import { stringCursorSeed } from "@/lib/infinite-query";
import { localISODate } from "@/lib/local-iso-date";
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
  /** Which Inbox lifecycle slice the window holds, signals included. */
  inboxView: InboxView;
};

/**
 * One server window of tasks and Inbox signals: the server filters, sorts and
 * pages both kinds under one cursor, so the client renders rows in the order
 * they arrive.
 */
export const entityViewRowsOptions = ({
  organizationId,
  scope,
  layout,
  inboxView,
}: EntityViewRowsOptions) => {
  const asOf = localISODate();
  return infiniteQueryOptions({
    queryKey: [
      ...entityViewKeys.all(organizationId),
      scope,
      layout.filters,
      layout.sorts,
      inboxView,
      asOf,
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
            inboxView,
            asOf,
            ...(pageParam ? { cursor: pageParam } : {}),
          },
          { fetch: { signal } },
        ),
      );
      return {
        ...page,
        items: page.items.map((item): EntityViewEntry => {
          switch (item.kind) {
            case ENTITY_VIEW_ROW_KIND.ENTITY:
              return {
                type: "entity",
                entity: toWorkspaceEntity(item.entity),
                workspaceId: item.entity.workspaceId,
                workspaceName: item.entity.workspaceName,
                workRisk: item.workRisk,
              };
            case ENTITY_VIEW_ROW_KIND.SIGNAL:
              return {
                type: "proposal",
                signal: item.signal,
                projection: toProposalProjection(item.projection),
              };
            default:
              item satisfies never;
              return panic("Unknown entity view row kind");
          }
        }),
      };
    },
    getNextPageParam: ({ nextCursor }) => nextCursor ?? undefined,
    staleTime: 60_000,
  });
};

type WireProjection = {
  kind: string | null;
  status: string | null;
  agendaKind: string | null;
  dueDate: string | null;
};

/**
 * The server maps every signal onto a task status and a task or deadline
 * type; a value outside those is a server bug, not a row to hide.
 */
const toProposalProjection = ({
  kind,
  status,
  agendaKind,
  dueDate,
}: WireProjection): ProposalProjection => {
  if (status !== null && !isTaskStatus(status)) {
    return panic(`Unknown proposal status: ${status}`);
  }
  if (agendaKind !== null && !isProposalType(agendaKind)) {
    return panic(`Unknown proposal type: ${agendaKind}`);
  }
  if (kind !== null && kind !== "task") {
    return panic(`Unknown proposal kind: ${kind}`);
  }
  return { kind, status, type: agendaKind, dueDate };
};

export const entityViewsOptions = (organizationId: string) =>
  queryOptions({
    queryKey: ["entity-view-layouts", organizationId],
    queryFn: async ({ signal }) =>
      unwrapEden(await api["entity-views"].get({ fetch: { signal } })),
  });
