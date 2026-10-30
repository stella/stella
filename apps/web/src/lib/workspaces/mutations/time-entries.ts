import {
  type QueryClient,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";

import { getTranslator } from "@/i18n/translator";
import { useAnalytics } from "@/lib/analytics/provider";
import { notifyUserError } from "@/lib/errors/user-toast";
import type { NonEmptyPatch } from "@/lib/mutation-command";
import { invoicesKeys } from "@/lib/workspaces/queries/invoices";
import { myTimeEntriesKeys } from "@/lib/workspaces/queries/my-time-entries";
import { timeApprovalsKeys } from "@/lib/workspaces/queries/time-approvals";
import { timeEntriesKeys } from "@/lib/workspaces/queries/time-entries";
import {
  approveTimeEntries,
  batchDeleteTimeEntries,
  batchUpdateTimeEntries,
  createTimeEntry,
  decideTimeSuggestion,
  deleteTimeEntry,
  returnTimeEntries,
  splitTimeEntry,
  updateTimeEntry,
} from "@/lib/workspaces/time-entries-api";

// A review decision changes the matters' time and what they can invoice, and
// every approver's queue. A batch the API refused entirely changed nothing.
const refreshReviewedTime = async (
  queryClient: QueryClient,
  workspaceIds: readonly string[],
  batch: { results: readonly { status: string }[] },
) => {
  if (batch.results.every(({ status }) => status === "refused")) {
    return;
  }
  await Promise.all([
    ...[...new Set(workspaceIds)].flatMap((workspaceId) => [
      queryClient.invalidateQueries({
        queryKey: timeEntriesKeys.all(workspaceId),
      }),
      queryClient.invalidateQueries({
        queryKey: invoicesKeys.all(workspaceId),
      }),
    ]),
    queryClient.invalidateQueries({ queryKey: timeApprovalsKeys.root }),
    // A reviewed entry can be the reviewer's own, shown in their week.
    queryClient.invalidateQueries({ queryKey: myTimeEntriesKeys.root() }),
  ]);
};

/**
 * Approves a selection in one call. The API answers per entry, so a refusal
 * (no rate, locked month, missing description) comes back as a result, not
 * as a failed request.
 */
export const useApproveTimeEntries = () => {
  const analytics = useAnalytics();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      ids,
    }: {
      /** The matters the entries belong to, whose time and invoices refresh. */
      workspaceIds: readonly string[];
      ids: readonly string[];
    }) => await approveTimeEntries(ids),
    onSuccess: async (batch, { workspaceIds }) => {
      await refreshReviewedTime(queryClient, workspaceIds, batch);
    },
    onError: (error) => {
      analytics.captureError(error, {
        fingerprintKey: "useApproveTimeEntries:failure",
        scope: { type: "handler", handlerId: "useApproveTimeEntries:failure" },
      });
      notifyUserError(error, getTranslator()("errors.actionFailed"));
    },
  });
};

/**
 * Returns a selection to draft with one comment in one call. Like approval,
 * a refusal comes back per entry, not as a failed request.
 */
export const useReturnTimeEntries = () => {
  const analytics = useAnalytics();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      ids,
      comment,
    }: {
      /** The matters the entries belong to, whose time and invoices refresh. */
      workspaceIds: readonly string[];
      ids: readonly string[];
      comment: string;
    }) => await returnTimeEntries({ ids, comment }),
    onSuccess: async (batch, { workspaceIds }) => {
      await refreshReviewedTime(queryClient, workspaceIds, batch);
    },
    onError: (error) => {
      analytics.captureError(error, {
        fingerprintKey: "useReturnTimeEntries:failure",
        scope: { type: "handler", handlerId: "useReturnTimeEntries:failure" },
      });
      notifyUserError(error, getTranslator()("errors.actionFailed"));
    },
  });
};

type CreateTimeEntryVars = {
  workspaceId: string;
  workItemId?: string | null;
  dateWorked: string;
  timezoneId: string;
  durationMinutes: number;
  narrative: string;
  narrativeLanguage?: string | null;
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
      await createTimeEntry(workspaceId, {
        ...body,
        ...(workItemId && { workItemId }),
      });
    },
    onError: (error) => {
      analytics.captureError(error, {
        fingerprintKey: "useCreateTimeEntry:failure",
        scope: { type: "handler", handlerId: "useCreateTimeEntry:failure" },
      });
      notifyUserError(error, getTranslator()("errors.actionFailed"));
    },
  });
};

type UpdateTimeEntryVars = {
  workspaceId: string;
  id: string;
  /** Another matter a draft moves to; the API re-prices it there. */
  moveTo?: string;
} & NonEmptyPatch<{
  dateWorked: string;
  timezoneId: string;
  durationMinutes: number;
  narrative: string;
  narrativeLanguage: string | null;
  invoiceNarrative: string | null;
  billable: boolean;
  noCharge: boolean;
  workItemId: string | null;
  taskCode: string | null;
  activityCode: string | null;
}>;

export const useUpdateTimeEntry = () => {
  const analytics = useAnalytics();

  return useMutation({
    mutationFn: async ({ workspaceId, ...body }: UpdateTimeEntryVars) => {
      const { id, workItemId, moveTo, ...restBody } = body;
      await updateTimeEntry(workspaceId, {
        ...restBody,
        id,
        ...(workItemId !== undefined && { workItemId }),
        ...(moveTo !== undefined && { moveToWorkspaceId: moveTo }),
      });
    },
    onError: (error) => {
      analytics.captureError(error, {
        fingerprintKey: "useUpdateTimeEntry:failure",
        scope: { type: "handler", handlerId: "useUpdateTimeEntry:failure" },
      });
      notifyUserError(error, getTranslator()("errors.actionFailed"));
    },
  });
};

type TimeSuggestionDecision =
  | {
      type: "accept";
      durationMinutes: number;
      narrative: string;
      narrativeLanguage?: string | null;
      billable?: boolean;
    }
  | { type: "dismiss" };

type DecideTimeSuggestionVars = {
  workspaceId: string;
  fingerprint: string;
  date: string;
  timezoneId: string;
  decision: TimeSuggestionDecision;
};

export const useDecideTimeSuggestion = () => {
  const analytics = useAnalytics();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ workspaceId, ...body }: DecideTimeSuggestionVars) => {
      await decideTimeSuggestion(workspaceId, body);
    },
    onSuccess: async (_result, { workspaceId }) => {
      // Accept creates an entry and both decisions retire a suggestion, so the
      // day's entries, summary, and suggestions all refetch together.
      await queryClient.invalidateQueries({
        queryKey: timeEntriesKeys.all(workspaceId),
      });
    },
    onError: (error) => {
      analytics.captureError(error, {
        fingerprintKey: "useDecideTimeSuggestion:failure",
        scope: {
          type: "handler",
          handlerId: "useDecideTimeSuggestion:failure",
        },
      });
      notifyUserError(error, getTranslator()("errors.actionFailed"));
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
      await deleteTimeEntry(workspaceId, id);
    },
    onError: (error) => {
      analytics.captureError(error, {
        fingerprintKey: "useDeleteTimeEntry:failure",
        scope: { type: "handler", handlerId: "useDeleteTimeEntry:failure" },
      });
      notifyUserError(error, getTranslator()("errors.actionFailed"));
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
      await batchUpdateTimeEntries(workspaceId, body);
    },
    onError: (error) => {
      analytics.captureError(error, {
        fingerprintKey: "useBatchUpdateTimeEntries:failure",
        scope: {
          type: "handler",
          handlerId: "useBatchUpdateTimeEntries:failure",
        },
      });
      notifyUserError(error, getTranslator()("errors.actionFailed"));
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
      await batchDeleteTimeEntries(workspaceId, ids);
    },
    onError: (error) => {
      analytics.captureError(error, {
        fingerprintKey: "useBatchDeleteTimeEntries:failure",
        scope: {
          type: "handler",
          handlerId: "useBatchDeleteTimeEntries:failure",
        },
      });
      notifyUserError(error, getTranslator()("errors.actionFailed"));
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
      await splitTimeEntry(workspaceId, body);
    },
    onError: (error) => {
      analytics.captureError(error, {
        fingerprintKey: "useSplitTimeEntry:failure",
        scope: { type: "handler", handlerId: "useSplitTimeEntry:failure" },
      });
      notifyUserError(error, getTranslator()("errors.actionFailed"));
    },
  });
};
