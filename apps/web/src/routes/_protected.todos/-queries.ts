import { queryOptions } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { unwrapEden } from "@/lib/errors/api";

const myTasksKeys = {
  all: ["my-tasks"],
};

export const myTasksOptions = queryOptions({
  queryKey: myTasksKeys.all,
  queryFn: async ({ signal }) => {
    const response = await api["my-tasks"].get({
      fetch: { signal },
    });

    return unwrapEden(response);
  },
});

/** Derived from the Eden response type. */
type QueryFn = NonNullable<(typeof myTasksOptions)["queryFn"]>;
export type TaskItem = NonNullable<Awaited<ReturnType<QueryFn>>>[number];
