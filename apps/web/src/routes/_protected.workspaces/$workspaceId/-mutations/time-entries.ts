import { usePostHog } from "@posthog/react";
import { useMutation } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { toAPIError } from "@/lib/errors";
import { captureError } from "@/lib/posthog/utils";
import { timeEntriesKeys } from "@/routes/_protected.workspaces/$workspaceId/-queries/time-entries";

type CreateTimeEntryVars = {
  workspaceId: string;
  matterId: string;
  dateWorked: string;
  timezoneId: string;
  durationMinutes: number;
  rateAtEntry: number;
  currency: string;
  narrative: string;
  billable?: boolean;
  taskCode?: string | null;
  activityCode?: string | null;
};

export const useCreateTimeEntry = () => {
  const posthog = usePostHog();

  return useMutation({
    mutationFn: async ({ workspaceId, ...body }: CreateTimeEntryVars) => {
      const response = await api["time-entries"]({ workspaceId }).put({
        queryKey: timeEntriesKeys.all(workspaceId),
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

type UpdateTimeEntryVars = {
  workspaceId: string;
  id: string;
  dateWorked?: string;
  durationMinutes?: number;
  narrative?: string;
  invoiceNarrative?: string | null;
  billable?: boolean;
  noCharge?: boolean;
  matterId?: string;
  taskCode?: string | null;
  activityCode?: string | null;
  status?: "draft" | "approved";
  rateAtEntry?: number;
  currency?: string;
};

export const useUpdateTimeEntry = () => {
  const posthog = usePostHog();

  return useMutation({
    mutationFn: async ({ workspaceId, ...body }: UpdateTimeEntryVars) => {
      const response = await api["time-entries"]({ workspaceId }).patch({
        queryKey: timeEntriesKeys.all(workspaceId),
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

type DeleteTimeEntryVars = {
  workspaceId: string;
  id: string;
};

export const useDeleteTimeEntry = () => {
  const posthog = usePostHog();

  return useMutation({
    mutationFn: async ({ workspaceId, id }: DeleteTimeEntryVars) => {
      const response = await api["time-entries"]({ workspaceId }).delete({
        queryKey: timeEntriesKeys.all(workspaceId),
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

type StartTimerVars = {
  workspaceId: string;
  matterId: string;
  timezoneId: string;
  rateAtEntry: number;
  currency: string;
  narrative?: string;
};

export const useStartTimer = () => {
  const posthog = usePostHog();

  return useMutation({
    mutationFn: async ({ workspaceId, ...body }: StartTimerVars) => {
      const response = await api["time-entries"]({
        workspaceId,
      }).timer.start.post({
        queryKey: timeEntriesKeys.all(workspaceId),
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

type StopTimerVars = {
  workspaceId: string;
};

export const useStopTimer = () => {
  const posthog = usePostHog();

  return useMutation({
    mutationFn: async ({ workspaceId }: StopTimerVars) => {
      const response = await api["time-entries"]({
        workspaceId,
      }).timer.stop.post({
        queryKey: timeEntriesKeys.all(workspaceId),
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

type BatchUpdateVars = {
  workspaceId: string;
  ids: string[];
  action: "approve" | "revert_to_draft" | "mark_billable" | "mark_non_billable";
};

export const useBatchUpdateTimeEntries = () => {
  const posthog = usePostHog();

  return useMutation({
    mutationFn: async ({ workspaceId, ...body }: BatchUpdateVars) => {
      const response = await api["time-entries"]({
        workspaceId,
      }).batch.post({
        queryKey: timeEntriesKeys.all(workspaceId),
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

type BatchDeleteVars = {
  workspaceId: string;
  ids: string[];
};

export const useBatchDeleteTimeEntries = () => {
  const posthog = usePostHog();

  return useMutation({
    mutationFn: async ({ workspaceId, ids }: BatchDeleteVars) => {
      const response = await api["time-entries"]({
        workspaceId,
      }).batch.delete({
        queryKey: timeEntriesKeys.all(workspaceId),
        ids,
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

type SplitTimeEntryVars = {
  workspaceId: string;
  id: string;
  splits: Array<{ matterId: string; percentage: number }>;
};

export const useSplitTimeEntry = () => {
  const posthog = usePostHog();

  return useMutation({
    mutationFn: async ({ workspaceId, ...body }: SplitTimeEntryVars) => {
      const response = await api["time-entries"]({
        workspaceId,
      }).split.post({
        queryKey: timeEntriesKeys.all(workspaceId),
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
