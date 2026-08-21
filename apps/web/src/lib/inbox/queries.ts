import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";

import type { SignalOrigin, SignalSeverity } from "@stll/api-contract/signals";

import { api } from "@/lib/api";
import { STALE_TIME } from "@/lib/consts";
import { unwrapEden } from "@/lib/errors/api";
import { stringCursorSeed } from "@/lib/infinite-query";
import { toSafeId } from "@/lib/safe-id";

export const INBOX_VIEWS = ["open", "snoozed", "resolved"] as const;
export type InboxView = (typeof INBOX_VIEWS)[number];

export type InboxFilters = {
  view: InboxView;
  workspaceId: string | null;
  origin: SignalOrigin | null;
  severity: SignalSeverity | null;
  assignedToMe: boolean;
};

export const DEFAULT_INBOX_FILTERS: InboxFilters = {
  view: "open",
  workspaceId: null,
  origin: null,
  severity: null,
  assignedToMe: false,
};

const INBOX_PAGE_SIZE = 30;
const INBOX_STALE_TIME_MS = 60 * 1000;

// Lives outside the route slice so every surface that mutates a signal
// (feed, inspector view, sidebar badge) invalidates the same root.
export const inboxKeys = {
  all: (organizationId: string) => ["inbox", organizationId] as const,
  list: (organizationId: string, filters: InboxFilters) =>
    [
      ...inboxKeys.all(organizationId),
      "list",
      filters.view,
      filters.workspaceId,
      filters.origin,
      filters.severity,
      filters.assignedToMe,
    ] as const,
  count: (organizationId: string) =>
    [...inboxKeys.all(organizationId), "count"] as const,
  detail: (organizationId: string, signalId: string) =>
    [...inboxKeys.all(organizationId), "detail", signalId] as const,
};

export const inboxSignalsOptions = (
  organizationId: string,
  filters: InboxFilters,
) =>
  infiniteQueryOptions({
    queryKey: inboxKeys.list(organizationId, filters),
    initialPageParam: stringCursorSeed(),
    queryFn: async ({ signal, pageParam }) => {
      const response = await api.signals.get({
        query: {
          view: filters.view,
          limit: INBOX_PAGE_SIZE,
          ...(filters.workspaceId
            ? { matterId: toSafeId<"workspace">(filters.workspaceId) }
            : {}),
          ...(filters.origin ? { origin: filters.origin } : {}),
          ...(filters.severity ? { severity: filters.severity } : {}),
          ...(filters.assignedToMe ? { assignedToMe: true } : {}),
          ...(pageParam ? { cursor: pageParam } : {}),
        },
        fetch: { signal },
      });
      return unwrapEden(response);
    },
    getNextPageParam: ({ nextCursor }) => nextCursor ?? undefined,
    staleTime: INBOX_STALE_TIME_MS,
  });

/** Open-count for the navigation badge; polled gently, never suspends. */
export const inboxCountOptions = (organizationId: string) =>
  queryOptions({
    queryKey: inboxKeys.count(organizationId),
    queryFn: async ({ signal }) =>
      unwrapEden(await api.signals.count.get({ fetch: { signal } })),
    staleTime: INBOX_STALE_TIME_MS,
    refetchInterval: STALE_TIME.FIVE.MINUTES,
  });

export const inboxSignalOptions = (organizationId: string, signalId: string) =>
  queryOptions({
    queryKey: inboxKeys.detail(organizationId, signalId),
    queryFn: async ({ signal }) =>
      unwrapEden(
        await api
          .signals({ signalId: toSafeId<"signal">(signalId) })
          .get({ fetch: { signal } }),
      ),
    staleTime: INBOX_STALE_TIME_MS,
  });

/** Derived from the Eden response type. */
type ListQueryFn = NonNullable<
  ReturnType<typeof inboxSignalsOptions>["queryFn"]
>;
type InboxPage = NonNullable<Awaited<ReturnType<ListQueryFn>>>;
export type InboxSignal = InboxPage["items"][number];
