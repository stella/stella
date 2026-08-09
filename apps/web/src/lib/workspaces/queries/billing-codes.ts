import { queryOptions } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { unwrapEden } from "@/lib/errors/api";
import { billingCodesQueryRoot } from "@/lib/resource-query-roots.logic";

export const billingCodesKeys = {
  all: billingCodesQueryRoot,
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

      return unwrapEden(response).items;
    },
  });
