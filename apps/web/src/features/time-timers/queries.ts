import { infiniteQueryOptions } from "@tanstack/react-query";

import { RESOURCE_TYPE } from "@stll/api-contract";

import { api } from "@/lib/api";
import { unwrapEden } from "@/lib/errors/api";
import { stringCursorSeed } from "@/lib/infinite-query";
import { resourceQueryOptions } from "@/lib/workspace-realtime";

export const timeTimersKeys = {
  all: (organizationId: string, userId: string) => [
    "timeTimers",
    organizationId,
    userId,
  ],
};

export const timeTimersOptions = (organizationId: string, userId: string) =>
  resourceQueryOptions(
    infiniteQueryOptions({
      queryKey: timeTimersKeys.all(organizationId, userId),
      initialPageParam: stringCursorSeed(),
      queryFn: async ({ pageParam, signal }) =>
        unwrapEden(
          await api["time-timers"].get({
            query: {
              limit: 100,
              ...(pageParam === undefined ? {} : { cursor: pageParam }),
            },
            fetch: { signal },
          }),
        ),
      getNextPageParam: (page) => page.nextCursor ?? undefined,
      staleTime: 30_000,
      refetchInterval: 60_000,
    }),
    {
      resources: [RESOURCE_TYPE.TIME_ENTRY],
      scope: { type: "organization" },
    },
  );
