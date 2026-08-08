import { infiniteQueryOptions } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { unwrapEden } from "@/lib/errors/api";
import { stringCursorSeed } from "@/lib/infinite-query";

export const myTasksKeys = {
  all: ["my-tasks"] as const,
  organization: (activeOrganizationId: string, status: MyTasksStatus | null) =>
    ["my-tasks", activeOrganizationId, status] as const,
};

export type MyTasksStatus = "done" | "in_progress" | "open";

export const myTasksOptions = (
  activeOrganizationId: string,
  status: MyTasksStatus | null,
) =>
  infiniteQueryOptions({
    queryKey: myTasksKeys.organization(activeOrganizationId, status),
    initialPageParam: stringCursorSeed(),
    queryFn: async ({ signal, pageParam }) => {
      const response = await api["my-tasks"].get({
        query: {
          limit: 50,
          ...(pageParam ? { cursor: pageParam } : {}),
          ...(status ? { status } : {}),
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
