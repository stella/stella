import { infiniteQueryOptions } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { unwrapEden } from "@/lib/errors/api";
import { stringCursorSeed } from "@/lib/infinite-query";

const MY_TIME_ENTRIES_PAGE_SIZE = 50;

export const myTimeEntriesKeys = {
  all: (organizationId: string) => ["myTimeEntries", organizationId],
  day: (organizationId: string, date: string) => [
    ...myTimeEntriesKeys.all(organizationId),
    { date },
  ],
};

export const myTimeEntriesInfiniteOptions = (
  organizationId: string,
  date: string,
) =>
  infiniteQueryOptions({
    queryKey: myTimeEntriesKeys.day(organizationId, date),
    initialPageParam: stringCursorSeed(),
    queryFn: async ({ pageParam, signal }) =>
      unwrapEden(
        await api["time-entries"].me.get({
          query: {
            date,
            limit: MY_TIME_ENTRIES_PAGE_SIZE,
            ...(pageParam === undefined ? {} : { cursor: pageParam }),
          },
          fetch: { signal },
        }),
      ),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
