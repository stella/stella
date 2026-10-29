import { infiniteQueryOptions } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { unwrapApiResponse } from "@/lib/errors/api";
import { stringCursorSeed } from "@/lib/infinite-query";

/** The API's largest page: a week of one person's entries usually fits in one. */
const MY_TIME_ENTRIES_PAGE_SIZE = 200;

type MyTimeEntriesRange = { startDate: string; endDate: string };

export const myTimeEntriesKeys = {
  root: () => ["myTimeEntries"],
  all: (organizationId: string) => [
    ...myTimeEntriesKeys.root(),
    organizationId,
  ],
  range: (
    organizationId: string,
    userId: string,
    { startDate, endDate }: MyTimeEntriesRange,
  ) => [
    ...myTimeEntriesKeys.all(organizationId),
    userId,
    { startDate, endDate },
  ],
};

const fetchMyTimeEntriesPage = async ({
  range,
  cursor,
  signal,
}: {
  range: MyTimeEntriesRange;
  cursor: string | undefined;
  signal: AbortSignal;
}) =>
  unwrapApiResponse(
    await api["time-entries"].me.get({
      query: {
        date: range.startDate,
        endDate: range.endDate,
        limit: MY_TIME_ENTRIES_PAGE_SIZE,
        ...(cursor === undefined ? {} : { cursor }),
      },
      fetch: { signal },
    }),
  );

export type MyTimeEntriesPage = Awaited<
  ReturnType<typeof fetchMyTimeEntriesPage>
>;

/** The signed-in person's entries across matters for one to seven work dates. */
export const myTimeEntriesInfiniteOptions = (
  organizationId: string,
  userId: string,
  range: MyTimeEntriesRange,
) =>
  infiniteQueryOptions({
    queryKey: myTimeEntriesKeys.range(organizationId, userId, range),
    initialPageParam: stringCursorSeed(),
    queryFn: async ({ pageParam, signal }) =>
      await fetchMyTimeEntriesPage({ range, cursor: pageParam, signal }),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
