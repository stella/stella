import { queryOptions } from "@tanstack/react-query";

import type { TimeTimer } from "@/features/time-timers/timer.logic";
import { api } from "@/lib/api";
import { unwrapEden } from "@/lib/errors/api";

export const timeTimersKeys = {
  all: (organizationId: string, userId: string) => [
    "timeTimers",
    organizationId,
    userId,
  ],
};

export const timeTimersOptions = (organizationId: string, userId: string) =>
  queryOptions({
    queryKey: timeTimersKeys.all(organizationId, userId),
    queryFn: async ({ signal }) => {
      const items: TimeTimer[] = [];
      let cursor: string | undefined;
      do {
        const page = unwrapEden(
          // oxlint-disable-next-line no-network-await-in-loop/no-network-await-in-loop -- cursor pagination: the next page needs this response's cursor
          await api["time-timers"].get({
            query: { limit: 100, ...(cursor === undefined ? {} : { cursor }) },
            fetch: { signal },
          }),
        );
        items.push(...page.items);
        cursor = page.nextCursor ?? undefined;
      } while (cursor !== undefined);
      return items;
    },
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
