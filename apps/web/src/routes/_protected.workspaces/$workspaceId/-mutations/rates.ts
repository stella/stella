import { useMutation } from "@tanstack/react-query";

import { useAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import { toAPIError } from "@/lib/errors";
import { toSafeId } from "@/lib/safe-id";
import { ratesKeys } from "@/routes/_protected.workspaces/$workspaceId/-queries/rates";

// --- Rate Tables ---

type CreateRateTableVars = {
  workspaceId: string;
  name: string;
  currency: string;
  isDefault?: boolean;
};

export const useCreateRateTable = () => {
  const analytics = useAnalytics();

  return useMutation({
    mutationFn: async ({ workspaceId, ...body }: CreateRateTableVars) => {
      const response = await api
        .rates({ workspaceId: toSafeId<"workspace">(workspaceId) })
        .put({
          queryKey: ratesKeys.all(workspaceId),
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

type UpdateRateTableVars = {
  workspaceId: string;
  id: string;
  name?: string;
  currency?: string;
  isDefault?: boolean;
};

export const useUpdateRateTable = () => {
  const analytics = useAnalytics();

  return useMutation({
    mutationFn: async ({ workspaceId, ...body }: UpdateRateTableVars) => {
      const response = await api
        .rates({ workspaceId: toSafeId<"workspace">(workspaceId) })
        .patch({
          queryKey: ratesKeys.all(workspaceId),
          ...body,
          id: toSafeId<"rateTable">(body.id),
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

type DeleteRateTableVars = {
  workspaceId: string;
  id: string;
};

export const useDeleteRateTable = () => {
  const analytics = useAnalytics();

  return useMutation({
    mutationFn: async ({ workspaceId, id }: DeleteRateTableVars) => {
      const response = await api
        .rates({ workspaceId: toSafeId<"workspace">(workspaceId) })
        .delete({
          queryKey: ratesKeys.all(workspaceId),
          id: toSafeId<"rateTable">(id),
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

// --- Rate Entries ---

type CreateRateEntryVars = {
  workspaceId: string;
  rateTableId: string;
  userId?: string | null;
  hourlyRate: number;
  effectiveFrom: string;
  effectiveTo?: string | null;
};

export const useCreateRateEntry = () => {
  const analytics = useAnalytics();

  return useMutation({
    mutationFn: async ({
      workspaceId,
      rateTableId,
      ...body
    }: CreateRateEntryVars) => {
      const { userId, ...restBody } = body;
      const response = await api
        .rates({ workspaceId: toSafeId<"workspace">(workspaceId) })({
          rateTableId: toSafeId<"rateTable">(rateTableId),
        })
        .entries.put({
          queryKey: ratesKeys.all(workspaceId),
          ...restBody,
          ...(userId !== undefined && {
            userId: userId === null ? null : toSafeId<"user">(userId),
          }),
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

type DeleteRateEntryVars = {
  workspaceId: string;
  rateTableId: string;
  id: string;
};

export const useDeleteRateEntry = () => {
  const analytics = useAnalytics();

  return useMutation({
    mutationFn: async ({
      workspaceId,
      rateTableId,
      id,
    }: DeleteRateEntryVars) => {
      const response = await api
        .rates({ workspaceId: toSafeId<"workspace">(workspaceId) })({
          rateTableId: toSafeId<"rateTable">(rateTableId),
        })
        .entries.delete({
          queryKey: ratesKeys.all(workspaceId),
          id: toSafeId<"rateEntry">(id),
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
