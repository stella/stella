import { useMutation } from "@tanstack/react-query";

import { useAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import { unwrapEden } from "@/lib/errors/api";
import { toSafeId } from "@/lib/safe-id";

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
    mutationFn: async ({ workspaceId, ...body }: CreateTimeEntryVars) => {
      const response = await api["time-entries"]({
        workspaceId: toSafeId<"workspace">(workspaceId),
      }).put({
        ...body,
        ...(body.workItemId && {
          workItemId: toSafeId<"entity">(body.workItemId),
        }),
      });

      return unwrapEden(response);
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
  workItemId?: string | null;
  taskCode?: string | null;
  activityCode?: string | null;
};

export const useUpdateTimeEntry = () => {
  const analytics = useAnalytics();

  return useMutation({
    mutationFn: async ({ workspaceId, ...body }: UpdateTimeEntryVars) => {
      const { id, workItemId, ...restBody } = body;
      const response = await api["time-entries"]({
        workspaceId: toSafeId<"workspace">(workspaceId),
      }).patch({
        ...restBody,
        id: toSafeId<"timeEntry">(id),
        ...(workItemId !== undefined && {
          workItemId: workItemId ? toSafeId<"entity">(workItemId) : null,
        }),
      });

      return unwrapEden(response);
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
        id: toSafeId<"timeEntry">(id),
      });

      return unwrapEden(response);
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
      const response = await api["time-entries"]({
        workspaceId: toSafeId<"workspace">(workspaceId),
      }).timer.start.post({
        ...body,
        workItemId: toSafeId<"entity">(body.workItemId),
      });

      return unwrapEden(response);
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
      }).timer.stop.post({});

      return unwrapEden(response);
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
        ...body,
        ids: body.ids.map((id) => toSafeId<"timeEntry">(id)),
      });

      return unwrapEden(response);
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
        ids: ids.map((id) => toSafeId<"timeEntry">(id)),
      });

      return unwrapEden(response);
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
      const response = await api["time-entries"]({
        workspaceId: toSafeId<"workspace">(workspaceId),
      }).split.post({
        ...body,
        id: toSafeId<"timeEntry">(body.id),
        splits: body.splits.map((split) => ({
          ...split,
          workItemId: toSafeId<"entity">(split.workItemId),
        })),
      });

      return unwrapEden(response);
    },
    onError: (error) => {
      analytics.captureError(error);
    },
  });
};
