import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { toAPIError } from "@/lib/errors";

/** Mirrors `INVOICE_STATUSES` in `apps/api/src/db/schema.ts`. */
type InvoiceStatus = "draft" | "finalized" | "sent" | "paid" | "void";

type InvoicesFilters = {
  limit?: number;
  cursor?: string;
};

type InvoicesListKey = {
  limit?: number | undefined;
  cursor?: string | undefined;
};

const getInitialInvoicesPageParam = (): string | undefined => undefined;

export const invoicesKeys = {
  all: (workspaceId: string) => ["invoices", workspaceId],
  list: (workspaceId: string, key: InvoicesListKey) => [
    ...invoicesKeys.all(workspaceId),
    { limit: key.limit, cursor: key.cursor },
  ],
  byId: (workspaceId: string, id: string) => [
    ...invoicesKeys.all(workspaceId),
    id,
  ],
};

export const invoicesOptions = (
  workspaceId: string,
  filters: InvoicesFilters = {},
) =>
  queryOptions({
    queryKey: invoicesKeys.list(workspaceId, filters),
    queryFn: async ({ signal }) => {
      const response = await api.invoices({ workspaceId }).get({
        query: filters,
        fetch: { signal },
      });

      if (response.error) {
        throw toAPIError(response.error);
      }

      return response.data;
    },
  });

export const invoicesInfiniteOptions = (workspaceId: string, limit: number) =>
  infiniteQueryOptions({
    queryKey: [...invoicesKeys.all(workspaceId), "infinite", { limit }],
    queryFn: async ({ pageParam, signal }) => {
      const response = await api.invoices({ workspaceId }).get({
        query: {
          limit,
          ...(pageParam === undefined ? {} : { cursor: pageParam }),
        },
        fetch: { signal },
      });

      if (response.error) {
        throw toAPIError(response.error);
      }

      return response.data;
    },
    initialPageParam: getInitialInvoicesPageParam(),
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  });

export const invoiceByIdOptions = (workspaceId: string, invoiceId: string) =>
  queryOptions({
    queryKey: invoicesKeys.byId(workspaceId, invoiceId),
    queryFn: async ({ signal }) => {
      const response = await api.invoices({ workspaceId })({ invoiceId }).get({
        fetch: { signal },
      });

      if (response.error) {
        throw toAPIError(response.error);
      }

      return response.data;
    },
  });

export type { InvoiceStatus };
