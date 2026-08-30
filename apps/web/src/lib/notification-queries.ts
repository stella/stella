import { infiniteQueryOptions } from "@tanstack/react-query";
import type { InfiniteData, QueryClient } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { unwrapEden } from "@/lib/errors/api";
import { stringCursorSeed } from "@/lib/infinite-query";

type NotificationsKey = {
  organizationId: string;
};

export const notificationKeys = {
  all: ({ organizationId }: NotificationsKey) =>
    ["notifications", organizationId] as const,
  list: (key: NotificationsKey) => [...notificationKeys.all(key), "list"],
};

/**
 * The bell's history, newest first.
 *
 * One page loads with the panel; older pages load only when the reader scrolls
 * for them, so opening the bell never drains a long history. The unread count
 * rides on every page and is computed server-side, so the badge stays right
 * however little of the history the client holds.
 */
export const notificationsOptions = ({ organizationId }: NotificationsKey) =>
  infiniteQueryOptions({
    queryKey: notificationKeys.list({ organizationId }),
    initialPageParam: stringCursorSeed(),
    queryFn: async ({ pageParam, signal }) =>
      unwrapEden(
        await api.notifications.get({
          query: { ...(pageParam ? { cursor: pageParam } : {}) },
          fetch: { signal },
        }),
      ),
    getNextPageParam: ({ nextCursor }) => nextCursor ?? undefined,
  });

/**
 * Drop every page but the first and refetch it.
 *
 * Used for both the realtime ping and after a mutation. Refetching only the
 * first page is the point: a reader who has paged back through months of
 * history must not trigger that whole walk again because one new notification
 * arrived.
 */
export const refetchFirstNotificationsPage = async ({
  organizationId,
  queryClient,
}: {
  organizationId: string;
  queryClient: QueryClient;
}): Promise<void> => {
  const queryKey = notificationKeys.list({ organizationId });
  queryClient.setQueryData(
    queryKey,
    (
      cached: InfiniteData<NotificationsPage, string | undefined> | undefined,
    ) =>
      cached === undefined
        ? cached
        : {
            pages: cached.pages.slice(0, 1),
            pageParams: cached.pageParams.slice(0, 1),
          },
  );
  await queryClient.invalidateQueries({ queryKey, refetchType: "active" });
};

type NotificationsQueryFn = NonNullable<
  ReturnType<typeof notificationsOptions>["queryFn"]
>;
type NotificationsPage = Awaited<ReturnType<NotificationsQueryFn>>;
export type Notification = NotificationsPage["items"][number];
