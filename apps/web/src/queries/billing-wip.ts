import { infiniteQueryOptions } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { unwrapEden } from "@/lib/errors/api";
import { stringCursorSeed } from "@/lib/infinite-query";
import { ROUTE_QUERY_STALE_TIME_MS } from "@/lib/react-query";
import { workspacesKeys } from "@/lib/workspaces/queries";

type WipQueryArgs = { organizationId: string; userId: string; asOf: string };

export const billingWipKeys = {
  all: (organizationId: string) => [
    ...workspacesKeys.all,
    "billingWip",
    organizationId,
  ],
  page: (
    { organizationId, userId, asOf }: WipQueryArgs,
    view: "matters" | "clients",
  ) => [...billingWipKeys.all(organizationId), userId, view, { asOf }],
};

export const wipMattersInfiniteOptions = (args: WipQueryArgs) =>
  infiniteQueryOptions({
    queryKey: billingWipKeys.page(args, "matters"),
    staleTime: ROUTE_QUERY_STALE_TIME_MS,
    initialPageParam: stringCursorSeed(),
    queryFn: async ({ pageParam, signal }) =>
      unwrapEden(
        await api.billing.wip.get({
          query: {
            asOf: args.asOf,
            limit: 25,
            ...(pageParam === undefined ? {} : { cursor: pageParam }),
          },
          fetch: { signal },
        }),
      ),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });

export const wipClientsInfiniteOptions = (args: WipQueryArgs) =>
  infiniteQueryOptions({
    queryKey: billingWipKeys.page(args, "clients"),
    staleTime: ROUTE_QUERY_STALE_TIME_MS,
    initialPageParam: stringCursorSeed(),
    queryFn: async ({ pageParam, signal }) =>
      unwrapEden(
        await api.billing.wip.clients.get({
          query: {
            asOf: args.asOf,
            limit: 25,
            ...(pageParam === undefined ? {} : { cursor: pageParam }),
          },
          fetch: { signal },
        }),
      ),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
