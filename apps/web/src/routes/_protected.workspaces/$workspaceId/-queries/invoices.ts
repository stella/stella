import { queryOptions } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { toAPIError } from "@/lib/errors";

/** Mirrors `invoiceStatusEnum` in `apps/api/src/db/schema.ts`. */
type InvoiceStatus = "draft" | "finalized" | "sent" | "paid" | "void";

type InvoicesFilters = {
  limit?: number;
  offset?: number;
};

export const invoicesKeys = {
  all: (workspaceId: string) => ["invoices", workspaceId],
  list: (workspaceId: string, filters: InvoicesFilters) => [
    ...invoicesKeys.all(workspaceId),
    filters,
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
