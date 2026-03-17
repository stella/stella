import { queryOptions } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { toAPIError } from "@/lib/errors";

export const billingCodesKeys = {
  all: (workspaceId: string) => ["billingCodes", workspaceId],
  list: (workspaceId: string, type?: string) => [
    ...billingCodesKeys.all(workspaceId),
    type,
  ],
};

export const billingCodesOptions = (
  workspaceId: string,
  type?: "task" | "activity",
) =>
  queryOptions({
    queryKey: billingCodesKeys.list(workspaceId, type),
    queryFn: async ({ signal }) => {
      const response = await api["billing-codes"]({
        workspaceId,
      }).get({
        query: {
          ...(type !== undefined && { type }),
          active: true,
        },
        fetch: { signal },
      });

      if (response.error) {
        throw toAPIError(response.error);
      }

      return response.data;
    },
  });
