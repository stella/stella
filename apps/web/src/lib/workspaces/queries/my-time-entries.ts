import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";

import { myTimeEntriesApi } from "@/lib/api";
import { unwrapEden } from "@/lib/errors/api";
import { stringCursorSeed } from "@/lib/infinite-query";

const MY_TIME_ENTRIES_PAGE_SIZE = 50;

export const myTimeEntriesKeys = {
  all: (organizationId: string) => ["myTimeEntries", organizationId],
  day: (organizationId: string, userId: string, date: string) => [
    ...myTimeEntriesKeys.all(organizationId),
    userId,
    { date },
  ],
};

export const myTimeEntriesInfiniteOptions = (
  organizationId: string,
  userId: string,
  date: string,
) =>
  infiniteQueryOptions({
    queryKey: myTimeEntriesKeys.day(organizationId, userId, date),
    initialPageParam: stringCursorSeed(),
    queryFn: async ({ pageParam, signal }) =>
      unwrapEden(
        await myTimeEntriesApi.get({
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

export const loggedTodayOptions = (
  organizationId: string,
  userId: string,
  date: string,
) =>
  queryOptions({
    queryKey: [...myTimeEntriesKeys.day(organizationId, userId, date), "total"],
    queryFn: async ({ signal }) => {
      let totalMinutes = 0;
      let cursor: string | undefined;
      do {
        const page = unwrapEden(
          // oxlint-disable-next-line no-network-await-in-loop/no-network-await-in-loop -- cursor pagination: the next page needs this response's cursor
          await myTimeEntriesApi.get({
            query: {
              date,
              limit: MY_TIME_ENTRIES_PAGE_SIZE,
              ...(cursor === undefined ? {} : { cursor }),
            },
            fetch: { signal },
          }),
        );
        for (const entry of page.items) {
          totalMinutes += entry.durationMinutes;
        }
        cursor = page.nextCursor ?? undefined;
      } while (cursor !== undefined);
      return totalMinutes;
    },
    staleTime: 30_000,
  });
