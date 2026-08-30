import { infiniteQueryOptions } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { unwrapEden } from "@/lib/errors/api";
import { stringCursorSeed } from "@/lib/infinite-query";

export const MY_WORK_QUEUES = [
  "to_acknowledge",
  "upcoming",
  "at_risk",
  "completed",
] as const;
export type MyWorkQueue = (typeof MY_WORK_QUEUES)[number];

// Exported so task surfaces that mutate a task invalidate the same root the
// work queues are keyed on instead of retyping it.
export const myWorkKeys = {
  all: ["my-work"] as const,
  queue: (queue: MyWorkQueue, asOf: string) =>
    [...myWorkKeys.all, queue, asOf] as const,
};

export const myWorkOptions = (queue: MyWorkQueue, asOf: string) =>
  infiniteQueryOptions({
    queryKey: myWorkKeys.queue(queue, asOf),
    initialPageParam: stringCursorSeed(),
    queryFn: async ({ signal, pageParam }) => {
      const response = await api["my-work"].get({
        query: {
          queue,
          asOf,
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
type QueryFn = NonNullable<ReturnType<typeof myWorkOptions>["queryFn"]>;
type MyWorkPage = NonNullable<Awaited<ReturnType<QueryFn>>>;
export type MyWorkItem = MyWorkPage["items"][number];
