import { useMutation } from "@tanstack/react-query";

import { useAnalytics } from "@/lib/analytics/provider";
import { timeEntriesKeys } from "@/lib/workspaces/queries/time-entries";
import { sendTimeEntryMutation } from "@/lib/workspaces/time-entries-api";

type CreateTimeEntryVars = {
  workspaceId: string;
  workItemId?: string | null;
  dateWorked: string;
  timezoneId: string;
  durationMinutes: number;
  narrative: string;
  billable?: boolean;
  taskCode?: string | null;
  activityCode?: string | null;
};

export const useCreateTimeEntry = () => {
  const analytics = useAnalytics();

  return useMutation({
    mutationFn: async ({
      workspaceId,
      workItemId,
      ...body
    }: CreateTimeEntryVars) => {
      await sendTimeEntryMutation({
        workspaceId,
        mutation: {
          type: "create",
          body: {
            queryKey: timeEntriesKeys.all(workspaceId),
            ...body,
            ...(workItemId && { workItemId }),
          },
        },
      });
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
  timezoneId?: string;
  durationMinutes?: number;
  narrative?: string;
  invoiceNarrative?: string | null;
  billable?: boolean;
  noCharge?: boolean;
  workItemId?: string | null;
  taskCode?: string | null;
  activityCode?: string | null;
};

export const useUpdateTimeEntry = () => {
  const analytics = useAnalytics();

  return useMutation({
    mutationFn: async ({ workspaceId, ...body }: UpdateTimeEntryVars) => {
      const { id, workItemId, ...restBody } = body;
      await sendTimeEntryMutation({
        workspaceId,
        mutation: {
          type: "update",
          body: {
            queryKey: timeEntriesKeys.all(workspaceId),
            ...restBody,
            id,
            ...(workItemId !== undefined && { workItemId }),
          },
        },
      });
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
      await sendTimeEntryMutation({
        workspaceId,
        mutation: {
          type: "delete",
          body: { queryKey: timeEntriesKeys.all(workspaceId), id },
        },
      });
    },
    onError: (error) => {
      analytics.captureError(error);
    },
  });
};

type StartTimerVars = {
  workspaceId: string;
  workItemId: string;
  timezoneId: string;
  narrative?: string;
};

export const useStartTimer = () => {
  const analytics = useAnalytics();

  return useMutation({
    mutationFn: async ({ workspaceId, ...body }: StartTimerVars) => {
      await sendTimeEntryMutation({
        workspaceId,
        mutation: {
          type: "timer_start",
          body: { queryKey: timeEntriesKeys.all(workspaceId), ...body },
        },
      });
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
      await sendTimeEntryMutation({
        workspaceId,
        mutation: {
          type: "timer_stop",
          body: { queryKey: timeEntriesKeys.all(workspaceId) },
        },
      });
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
      await sendTimeEntryMutation({
        workspaceId,
        mutation: {
          type: "batch_update",
          body: {
            queryKey: timeEntriesKeys.all(workspaceId),
            ...body,
          },
        },
      });
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
      await sendTimeEntryMutation({
        workspaceId,
        mutation: {
          type: "batch_delete",
          body: { queryKey: timeEntriesKeys.all(workspaceId), ids },
        },
      });
    },
    onError: (error) => {
      analytics.captureError(error);
    },
  });
};

type SplitTimeEntryVars = {
  workspaceId: string;
  id: string;
  splits: { workItemId: string; percentage: number }[];
};

export const useSplitTimeEntry = () => {
  const analytics = useAnalytics();

  return useMutation({
    mutationFn: async ({ workspaceId, ...body }: SplitTimeEntryVars) => {
      await sendTimeEntryMutation({
        workspaceId,
        mutation: {
          type: "split",
          body: {
            queryKey: timeEntriesKeys.all(workspaceId),
            ...body,
          },
        },
      });
    },
    onError: (error) => {
      analytics.captureError(error);
    },
  });
};
