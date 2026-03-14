import { usePostHog } from "@posthog/react";
import { useMutation } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { toAPIError } from "@/lib/errors";
import { captureError } from "@/lib/posthog/utils";
import { ratesKeys } from "@/routes/_protected.workspaces/$workspaceId/-queries/rates";

// --- Rate Tables ---

type CreateRateTableVars = {
  workspaceId: string;
  name: string;
  currency: string;
  isDefault?: boolean;
};

export const useCreateRateTable = () => {
  const posthog = usePostHog();

  return useMutation({
    mutationFn: async ({ workspaceId, ...body }: CreateRateTableVars) => {
      const response = await api.rates({ workspaceId }).put({
        queryKey: ratesKeys.all(workspaceId),
        ...body,
      });

      if (response.error) {
        throw toAPIError(response.error);
      }

      return response.data;
    },
    onError: (error) => {
      captureError(posthog, error);
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
  const posthog = usePostHog();

  return useMutation({
    mutationFn: async ({ workspaceId, ...body }: UpdateRateTableVars) => {
      const response = await api.rates({ workspaceId }).patch({
        queryKey: ratesKeys.all(workspaceId),
        ...body,
      });

      if (response.error) {
        throw toAPIError(response.error);
      }

      return response.data;
    },
    onError: (error) => {
      captureError(posthog, error);
    },
  });
};

type DeleteRateTableVars = {
  workspaceId: string;
  id: string;
};

export const useDeleteRateTable = () => {
  const posthog = usePostHog();

  return useMutation({
    mutationFn: async ({ workspaceId, id }: DeleteRateTableVars) => {
      const response = await api.rates({ workspaceId }).delete({
        queryKey: ratesKeys.all(workspaceId),
        id,
      });

      if (response.error) {
        throw toAPIError(response.error);
      }

      return response.data;
    },
    onError: (error) => {
      captureError(posthog, error);
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
  const posthog = usePostHog();

  return useMutation({
    mutationFn: async ({
      workspaceId,
      rateTableId,
      ...body
    }: CreateRateEntryVars) => {
      const response = await api
        .rates({ workspaceId })({ rateTableId })
        .entries.put({
          queryKey: ratesKeys.all(workspaceId),
          ...body,
        });

      if (response.error) {
        throw toAPIError(response.error);
      }

      return response.data;
    },
    onError: (error) => {
      captureError(posthog, error);
    },
  });
};

type DeleteRateEntryVars = {
  workspaceId: string;
  rateTableId: string;
  id: string;
};

export const useDeleteRateEntry = () => {
  const posthog = usePostHog();

  return useMutation({
    mutationFn: async ({
      workspaceId,
      rateTableId,
      id,
    }: DeleteRateEntryVars) => {
      const response = await api
        .rates({ workspaceId })({ rateTableId })
        .entries.delete({
          queryKey: ratesKeys.all(workspaceId),
          id,
        });

      if (response.error) {
        throw toAPIError(response.error);
      }

      return response.data;
    },
    onError: (error) => {
      captureError(posthog, error);
    },
  });
};
