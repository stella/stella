import { queryOptions } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { unwrapEden } from "@/lib/errors/api";

export const myTasksKeys = {
  all: ["my-tasks"] as const,
  organization: (activeOrganizationId: string) =>
    ["my-tasks", activeOrganizationId] as const,
};

export const myTasksOptions = (activeOrganizationId: string) =>
  queryOptions({
    queryKey: myTasksKeys.organization(activeOrganizationId),
    queryFn: async ({ signal }) => {
      const response = await api["my-tasks"].get({
        fetch: { signal },
      });

      return unwrapEden(response);
    },
  });

/** Derived from the Eden response type. */
type QueryFn = NonNullable<ReturnType<typeof myTasksOptions>["queryFn"]>;
export type TaskItem = NonNullable<Awaited<ReturnType<QueryFn>>>[number];
