import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";

import type { InvoiceStatus } from "@stll/api-contract";

import { api } from "@/lib/api";
import { unwrapApiResponse } from "@/lib/errors/api";
import { ROUTE_QUERY_STALE_TIME_MS } from "@/lib/react-query";
import { invoicesQueryRoot } from "@/lib/resource-query-roots.logic";

const getInitialInvoicesPageParam = (): string | undefined => undefined;

export const invoicesKeys = {
  all: invoicesQueryRoot,
  infinite: (workspaceId: string, limit: number) => [
    ...invoicesKeys.all(workspaceId),
    "infinite",
    { limit },
  ],
  byId: (workspaceId: string, id: string) => [
    ...invoicesKeys.all(workspaceId),
    id,
  ],
};

export const invoicesInfiniteOptions = (workspaceId: string, limit: number) =>
  infiniteQueryOptions({
    queryKey: invoicesKeys.infinite(workspaceId, limit),
    queryFn: async ({ pageParam, signal }) => {
      const response = await api.invoices({ workspaceId }).get({
        query: {
          limit,
          ...(pageParam === undefined ? {} : { cursor: pageParam }),
        },
        fetch: { signal },
      });

      return unwrapApiResponse(response);
    },
    initialPageParam: getInitialInvoicesPageParam(),
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  });

export const invoiceByIdOptions = (workspaceId: string, invoiceId: string) =>
  queryOptions({
    queryKey: invoicesKeys.byId(workspaceId, invoiceId),
    staleTime: ROUTE_QUERY_STALE_TIME_MS,
    queryFn: async ({ signal }) => {
      const response = await api.invoices({ workspaceId })({ invoiceId }).get({
        fetch: { signal },
      });

      return unwrapApiResponse(response);
    },
  });

/**
 * What a new invoice in the matter starts from: unbilled entries and
 * expenses, the seller, buyer, VAT and payment term with their sources.
 * Always refetched on open, since billing elsewhere changes what is unbilled.
 */
export const invoicePrefillOptions = (workspaceId: string) =>
  queryOptions({
    queryKey: [...invoicesKeys.all(workspaceId), "prefill"],
    staleTime: 0,
    queryFn: async ({ signal }) => {
      const response = await api
        .invoices({ workspaceId })
        .prefill.get({ query: {}, fetch: { signal } });

      return unwrapApiResponse(response);
    },
  });

export type InvoicePrefill = Awaited<
  ReturnType<NonNullable<ReturnType<typeof invoicePrefillOptions>["queryFn"]>>
>;

export type { InvoiceStatus };
