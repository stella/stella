import { useMutation } from "@tanstack/react-query";

import { useAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import { toAPIError } from "@/lib/errors";
import { billingCodesKeys } from "@/routes/_protected.workspaces/$workspaceId/-queries/billing-codes";

type CreateBillingCodeVars = {
  workspaceId: string;
  type: "task" | "activity";
  code: string;
  label: string;
  active?: boolean;
  sortOrder?: number;
};

export const useCreateBillingCode = () => {
  const analytics = useAnalytics();

  return useMutation({
    mutationFn: async ({ workspaceId, ...body }: CreateBillingCodeVars) => {
      const response = await api["billing-codes"]({
        workspaceId,
      }).put({
        queryKey: billingCodesKeys.all(workspaceId),
        ...body,
      });

      if (response.error) {
        throw toAPIError(response.error);
      }

      return response.data;
    },
    onError: (error) => {
      analytics.captureError(error);
    },
  });
};

type UpdateBillingCodeVars = {
  workspaceId: string;
  id: string;
  code?: string;
  label?: string;
  active?: boolean;
  sortOrder?: number;
};

export const useUpdateBillingCode = () => {
  const analytics = useAnalytics();

  return useMutation({
    mutationFn: async ({ workspaceId, ...body }: UpdateBillingCodeVars) => {
      const response = await api["billing-codes"]({
        workspaceId,
      }).patch({
        queryKey: billingCodesKeys.all(workspaceId),
        ...body,
      });

      if (response.error) {
        throw toAPIError(response.error);
      }

      return response.data;
    },
    onError: (error) => {
      analytics.captureError(error);
    },
  });
};

type DeleteBillingCodeVars = {
  workspaceId: string;
  id: string;
};

export const useDeleteBillingCode = () => {
  const analytics = useAnalytics();

  return useMutation({
    mutationFn: async ({ workspaceId, id }: DeleteBillingCodeVars) => {
      const response = await api["billing-codes"]({
        workspaceId,
      }).delete({
        queryKey: billingCodesKeys.all(workspaceId),
        id,
      });

      if (response.error) {
        throw toAPIError(response.error);
      }

      return response.data;
    },
    onError: (error) => {
      analytics.captureError(error);
    },
  });
};
