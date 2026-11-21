import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";

import { RESOURCE_TYPE } from "@stll/api-contract";

import type { Week } from "@/components/billing/work-week.logic";
import { api } from "@/lib/api";
import { unwrapApiResponse } from "@/lib/errors/api";
import { stringCursorSeed } from "@/lib/infinite-query";
import { resourceQueryOptions } from "@/lib/workspace-realtime";

/** The API's largest page: a week of submitted time usually fits in one. */
const TIME_APPROVALS_PAGE_SIZE = 200;

export type TimeApprovalFilters = {
  member?: string | undefined;
  matter?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
};

export const timeApprovalsKeys = {
  root: ["timeApprovals"],
  all: (organizationId: string) => [...timeApprovalsKeys.root, organizationId],
  list: (
    organizationId: string,
    userId: string,
    filters: TimeApprovalFilters,
  ) => [...timeApprovalsKeys.all(organizationId), userId, "list", filters],
  pending: (organizationId: string, userId: string) => [
    ...timeApprovalsKeys.all(organizationId),
    userId,
    "pending",
  ],
};

const fetchApprovalQueuePage = async ({
  filters,
  limit,
  cursor,
  signal,
}: {
  filters: TimeApprovalFilters;
  limit: number;
  cursor: string | undefined;
  signal: AbortSignal;
}) =>
  unwrapApiResponse(
    await api["time-entries"]["approval-queue"].get({
      query: {
        ...(filters.member === undefined ? {} : { member: filters.member }),
        ...(filters.matter === undefined ? {} : { matter: filters.matter }),
        ...(filters.from === undefined ? {} : { from: filters.from }),
        ...(filters.to === undefined ? {} : { to: filters.to }),
        limit,
        ...(cursor === undefined ? {} : { cursor }),
      },
      fetch: { signal },
    }),
  );

type TimeApprovalQueuePage = Awaited<ReturnType<typeof fetchApprovalQueuePage>>;
export type TimeApprovalItem = TimeApprovalQueuePage["items"][number];

/** Submitted time waiting for the signed-in approver, within the filters. */
export const timeApprovalQueueOptions = (
  organizationId: string,
  userId: string,
  filters: TimeApprovalFilters,
) =>
  resourceQueryOptions(
    infiniteQueryOptions({
      queryKey: timeApprovalsKeys.list(organizationId, userId, filters),
      initialPageParam: stringCursorSeed(),
      queryFn: async ({ pageParam, signal }) =>
        await fetchApprovalQueuePage({
          filters,
          limit: TIME_APPROVALS_PAGE_SIZE,
          cursor: pageParam,
          signal,
        }),
      getNextPageParam: (page) => page.nextCursor ?? undefined,
    }),
    {
      resources: [RESOURCE_TYPE.TIME_ENTRY],
      scope: { type: "organization", organizationId, userId },
    },
  );

/**
 * The queue the page reads: one week, narrowed by the server to a person and
 * a matter, so a filter never depends on which pages happen to be loaded.
 */
export const timeApprovalsQuery = (
  organizationId: string,
  userId: string,
  week: Week,
  { member, matter }: Pick<TimeApprovalFilters, "member" | "matter">,
) =>
  timeApprovalQueueOptions(organizationId, userId, {
    from: week.start,
    to: week.end,
    ...(member === undefined ? {} : { member }),
    ...(matter === undefined ? {} : { matter }),
  });

/** How many submitted entries wait for this approver (bounded by the API). */
export const timeApprovalPendingOptions = (
  organizationId: string,
  userId: string,
) =>
  queryOptions({
    queryKey: timeApprovalsKeys.pending(organizationId, userId),
    queryFn: async ({ signal }) =>
      (
        await fetchApprovalQueuePage({
          filters: {},
          limit: 1,
          cursor: undefined,
          signal,
        })
      ).pendingCount,
  });
