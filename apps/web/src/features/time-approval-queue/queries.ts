import { infiniteQueryOptions } from "@tanstack/react-query";

import { mapWithConcurrency } from "@stll/concurrency";

import { normalizeApprovalFilters } from "@/features/time-approval-queue/filters.logic";
import type { ApprovalFilters } from "@/features/time-approval-queue/filters.logic";
import { timeApprovalQueueApi } from "@/lib/api";
import { unwrapEden } from "@/lib/errors/api";
import { stringCursorSeed } from "@/lib/infinite-query";
import { ROUTE_QUERY_STALE_TIME_MS } from "@/lib/react-query";
import { toSafeId } from "@/lib/safe-id";

const APPROVAL_PAGE_SIZE = 50;
const APPROVAL_BATCH_SIZE = 200;

const fetchApprovalQueue = async (
  {
    limit,
    cursor,
    ...filters
  }: ApprovalFilters & { limit: number; cursor?: string },
  signal: AbortSignal,
) => {
  const { matter, ...query } = normalizeApprovalFilters(filters);
  return unwrapEden(
    await timeApprovalQueueApi["approval-queue"].get({
      query: {
        ...query,
        limit,
        ...(cursor === undefined ? {} : { cursor }),
        ...(matter === undefined
          ? {}
          : { matter: toSafeId<"workspace">(matter) }),
      },
      fetch: { signal },
    }),
  );
};

export type ApprovalEntry = Awaited<
  ReturnType<typeof fetchApprovalQueue>
>["items"][number];

export const approvalQueueKeys = {
  all: ({ organizationId, userId }: ApprovalQueueIdentity) => [
    "approvalQueue",
    organizationId,
    userId,
  ],
  list: ({ organizationId, userId, filters }: ApprovalQueueOptions) => [
    ...approvalQueueKeys.all({ organizationId, userId }),
    filters,
  ],
};

type ApprovalQueueIdentity = { organizationId: string; userId: string };
type ApprovalQueueOptions = ApprovalQueueIdentity & {
  filters: ApprovalFilters;
};

export const approvalQueueOptions = ({
  organizationId,
  userId,
  filters,
}: ApprovalQueueOptions) =>
  infiniteQueryOptions({
    queryKey: approvalQueueKeys.list({ organizationId, userId, filters }),
    initialPageParam: stringCursorSeed(),
    staleTime: ROUTE_QUERY_STALE_TIME_MS,
    queryFn: async ({ pageParam, signal }) =>
      fetchApprovalQueue(
        {
          ...filters,
          limit: APPROVAL_PAGE_SIZE,
          ...(pageParam === undefined ? {} : { cursor: pageParam }),
        },
        signal,
      ),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });

const approveBatch = async (ids: string[]) =>
  unwrapEden(
    await timeApprovalQueueApi.approve.post({
      ids: ids.map((id) => toSafeId<"timeEntry">(id)),
    }),
  );
export type ApprovalResult = Awaited<
  ReturnType<typeof approveBatch>
>["results"][number];

export const approveTimeEntries = async (ids: string[]) => {
  const uniqueIds = [...new Set(ids)];
  const batches = Array.from(
    { length: Math.ceil(uniqueIds.length / APPROVAL_BATCH_SIZE) },
    (_, index) =>
      uniqueIds.slice(
        index * APPROVAL_BATCH_SIZE,
        (index + 1) * APPROVAL_BATCH_SIZE,
      ),
  );
  const responses = await mapWithConcurrency({
    items: batches,
    limit: 1,
    operation: approveBatch,
  });
  return responses.flatMap((response) => response.results);
};

export const returnTimeEntry = async ({
  id,
  comment,
}: {
  id: string;
  comment: string;
}) =>
  unwrapEden(
    await timeApprovalQueueApi["approval-queue"].return.post({
      id: toSafeId<"timeEntry">(id),
      comment,
    }),
  );
