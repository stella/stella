import { infiniteQueryOptions } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { unwrapEden } from "@/lib/errors/api";
import { stringCursorSeed } from "@/lib/infinite-query";

export const globalTimeTimersKeys = {
  all: (organizationId: string, userId: string) => [
    "timeTimers",
    organizationId,
    userId,
  ],
};

export const listMyTimers = async (
  signal: AbortSignal,
  cursor: string | undefined,
) =>
  unwrapEden(
    await api["time-timers"].get({
      query: { limit: 50, ...(cursor === undefined ? {} : { cursor }) },
      fetch: { signal },
    }),
  );

export const globalTimeTimersOptions = (
  organizationId: string,
  userId: string,
) =>
  infiniteQueryOptions({
    queryKey: globalTimeTimersKeys.all(organizationId, userId),
    initialPageParam: stringCursorSeed(),
    queryFn: async ({ signal, pageParam }) =>
      await listMyTimers(signal, pageParam),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
