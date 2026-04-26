import { useMutation } from "@tanstack/react-query";

import { useAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import { toAPIError } from "@/lib/errors";
import { toSafeId } from "@/lib/safe-id";
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
  const analytics = useAnalytics();

  return useMutation({
    mutationFn: async ({ workspaceId, ...body }: CreateTimeEntryVars) => {
      const response = await api["time-entries"]({
        workspaceId: toSafeId<"workspace">(workspaceId),
      }).put({
        queryKey: timeEntriesKeys.all(workspaceId),
        ...body,
        matterId: toSafeId<"entity">(body.matterId),
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
  const analytics = useAnalytics();

  return useMutation({
    mutationFn: async ({ workspaceId, ...body }: UpdateTimeEntryVars) => {
      const { id, matterId, ...restBody } = body;
      const response = await api["time-entries"]({
        workspaceId: toSafeId<"workspace">(workspaceId),
      }).patch({
        queryKey: timeEntriesKeys.all(workspaceId),
        ...restBody,
        id: toSafeId<"timeEntry">(id),
        ...(matterId !== undefined && {
          matterId: toSafeId<"entity">(matterId),
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

type DeleteTimeEntryVars = {
  workspaceId: string;
  id: string;
};

export const useDeleteTimeEntry = () => {
  const analytics = useAnalytics();

  return useMutation({
    mutationFn: async ({ workspaceId, id }: DeleteTimeEntryVars) => {
      const response = await api["time-entries"]({
        workspaceId: toSafeId<"workspace">(workspaceId),
      }).delete({
        queryKey: timeEntriesKeys.all(workspaceId),
        id: toSafeId<"timeEntry">(id),
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

type StartTimerVars = {
  workspaceId: string;
  matterId: string;
  timezoneId: string;
  rateAtEntry: number;
  currency: string;
  narrative?: string;
};

export const useStartTimer = () => {
  const analytics = useAnalytics();

  return useMutation({
    mutationFn: async ({ workspaceId, ...body }: StartTimerVars) => {
      const response = await api["time-entries"]({
        workspaceId: toSafeId<"workspace">(workspaceId),
      }).timer.start.post({
        queryKey: timeEntriesKeys.all(workspaceId),
        ...body,
        matterId: toSafeId<"entity">(body.matterId),
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

type StopTimerVars = {
  workspaceId: string;
};

export const useStopTimer = () => {
  const analytics = useAnalytics();

  return useMutation({
    mutationFn: async ({ workspaceId }: StopTimerVars) => {
      const response = await api["time-entries"]({
        workspaceId: toSafeId<"workspace">(workspaceId),
      }).timer.stop.post({
        queryKey: timeEntriesKeys.all(workspaceId),
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

type BatchUpdateVars = {
  workspaceId: string;
  ids: string[];
  action: "approve" | "revert_to_draft" | "mark_billable" | "mark_non_billable";
};

export const useBatchUpdateTimeEntries = () => {
  const analytics = useAnalytics();

  return useMutation({
    mutationFn: async ({ workspaceId, ...body }: BatchUpdateVars) => {
      const response = await api["time-entries"]({
        workspaceId: toSafeId<"workspace">(workspaceId),
      }).batch.post({
        queryKey: timeEntriesKeys.all(workspaceId),
        ...body,
        ids: body.ids.map((id) => toSafeId<"timeEntry">(id)),
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

type BatchDeleteVars = {
  workspaceId: string;
  ids: string[];
};

export const useBatchDeleteTimeEntries = () => {
  const analytics = useAnalytics();

  return useMutation({
    mutationFn: async ({ workspaceId, ids }: BatchDeleteVars) => {
      const response = await api["time-entries"]({
        workspaceId: toSafeId<"workspace">(workspaceId),
      }).batch.delete({
        queryKey: timeEntriesKeys.all(workspaceId),
        ids: ids.map((id) => toSafeId<"timeEntry">(id)),
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

type SplitTimeEntryVars = {
  workspaceId: string;
  id: string;
  splits: { matterId: string; percentage: number }[];
};

export const useSplitTimeEntry = () => {
  const analytics = useAnalytics();

  return useMutation({
    mutationFn: async ({ workspaceId, ...body }: SplitTimeEntryVars) => {
      const response = await api["time-entries"]({
        workspaceId: toSafeId<"workspace">(workspaceId),
      }).split.post({
        queryKey: timeEntriesKeys.all(workspaceId),
        ...body,
        id: toSafeId<"timeEntry">(body.id),
        splits: body.splits.map((split) => ({
          ...split,
          matterId: toSafeId<"entity">(split.matterId),
        })),
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
