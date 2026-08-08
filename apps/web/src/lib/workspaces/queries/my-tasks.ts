import { infiniteQueryOptions } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { unwrapEden } from "@/lib/errors/api";
import { stringCursorSeed } from "@/lib/infinite-query";

export const myTasksKeys = {
  all: ["my-tasks"] as const,
  organization: (activeOrganizationId: string) =>
    ["my-tasks", activeOrganizationId] as const,
};

export const myTasksOptions = (activeOrganizationId: string) =>
  infiniteQueryOptions({
    queryKey: myTasksKeys.organization(activeOrganizationId),
    initialPageParam: stringCursorSeed(),
    queryFn: async ({ signal, pageParam }) => {
      const response = await api["my-tasks"].get({
        query: {
          limit: 50,
          ...(pageParam ? { cursor: pageParam } : {}),
        },
        fetch: { signal },
      });

      return unwrapEden(response);
    },
    getNextPageParam: ({ nextCursor }) => nextCursor ?? undefined,
  });

/** Derived from the Eden response type. */
type QueryFn = NonNullable<ReturnType<typeof myTasksOptions>["queryFn"]>;
type MyTasksPage = NonNullable<Awaited<ReturnType<QueryFn>>>;
export type TaskItem = MyTasksPage["items"][number];
