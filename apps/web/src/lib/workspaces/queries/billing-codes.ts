import { queryOptions } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { unwrapEden } from "@/lib/errors/api";
import { billingCodesQueryRoot } from "@/lib/resource-query-roots.logic";

const BILLING_CODE_QUERY_MODE = {
  ACTIVE: "active",
  ALL: "all",
} as const;

type BillingCodesListParams = {
  workspaceId: string;
  type: "task" | "activity" | undefined;
  mode: (typeof BILLING_CODE_QUERY_MODE)[keyof typeof BILLING_CODE_QUERY_MODE];
};

const billingCodesKeys = {
  all: billingCodesQueryRoot,
  list: ({ workspaceId, type, mode }: BillingCodesListParams) =>
    [...billingCodesKeys.all(workspaceId), type, mode] as const,
};

const codeListOptions = ({ workspaceId, type, mode }: BillingCodesListParams) =>
  queryOptions({
    queryKey: billingCodesKeys.list({ workspaceId, type, mode }),
    queryFn: async ({ signal }) => {
      const response = await api["billing-codes"]({
        workspaceId,
      }).get({
        query: {
          ...(type !== undefined && { type }),
          ...(mode === BILLING_CODE_QUERY_MODE.ACTIVE && { active: true }),
        },
        fetch: { signal },
      });

      return unwrapEden(response).items;
    },
  });

export const billingCodesOptions = (
  workspaceId: string,
  type?: "task" | "activity",
) =>
  codeListOptions({ workspaceId, type, mode: BILLING_CODE_QUERY_MODE.ACTIVE });

export const billingCodesManagementOptions = (
  workspaceId: string,
  type: "task" | "activity",
) => codeListOptions({ workspaceId, type, mode: BILLING_CODE_QUERY_MODE.ALL });
