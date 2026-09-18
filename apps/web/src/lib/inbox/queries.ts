import { queryOptions } from "@tanstack/react-query";

import { SIGNAL_VIEWS } from "@stll/api-contract/signals";
import type { SignalView } from "@stll/api-contract/signals";

import { api } from "@/lib/api";
import { STALE_TIME } from "@/lib/consts";
import { unwrapEden } from "@/lib/errors/api";
import { localISODate } from "@/lib/local-iso-date";
import { toSafeId } from "@/lib/safe-id";
import { myWorkKeys } from "@/lib/workspaces/queries/my-work";

export const INBOX_VIEWS = SIGNAL_VIEWS;
export type InboxView = SignalView;

const INBOX_STALE_TIME_MS = 60 * 1000;

// Lives outside the route slice so every surface that mutates a signal
// (feed, inspector view, sidebar badge) invalidates the same root. It nests
// under the work root because the badge counts due tasks too: every task
// mutation already invalidates `myWorkKeys.all`.
export const inboxKeys = {
  all: (organizationId: string) =>
    [...myWorkKeys.all, "inbox", organizationId] as const,
  count: (organizationId: string, asOf: string) =>
    [...inboxKeys.all(organizationId), "count", asOf] as const,
  detail: (organizationId: string, signalId: string) =>
    [...inboxKeys.all(organizationId), "detail", signalId] as const,
};

/**
 * Badge count: open signals plus the caller's tasks due on or before their
 * own calendar day. Polled gently, never suspends.
 */
export const inboxCountOptions = (organizationId: string) => {
  const asOf = localISODate();
  return queryOptions({
    queryKey: inboxKeys.count(organizationId, asOf),
    queryFn: async ({ signal }) =>
      unwrapEden(
        await api.signals.count.get({ query: { asOf }, fetch: { signal } }),
      ),
    staleTime: INBOX_STALE_TIME_MS,
    refetchInterval: STALE_TIME.FIVE.MINUTES,
  });
};

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
type DetailQueryFn = NonNullable<
  ReturnType<typeof inboxSignalOptions>["queryFn"]
>;
export type InboxSignal = NonNullable<Awaited<ReturnType<DetailQueryFn>>>;
