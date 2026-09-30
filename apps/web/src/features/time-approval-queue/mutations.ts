import { useMutation, useQueryClient } from "@tanstack/react-query";

import { stellaToast } from "@stll/ui/toast";

import {
  approveTimeEntries,
  approvalQueueKeys,
  returnTimeEntry,
} from "@/features/time-approval-queue/queries";
import { useAnalytics } from "@/lib/analytics/provider";
import { myTimeEntriesKeys } from "@/lib/workspaces/queries/my-time-entries";
import { timeEntriesKeys } from "@/lib/workspaces/queries/time-entries";

type ApprovalMutationOptions = { organizationId: string; userId: string };
export const useApprovalMutations = ({
  organizationId,
  userId,
}: ApprovalMutationOptions) => {
  const queryClient = useQueryClient();
  const analytics = useAnalytics();
  const onError = (error: Error) => {
    analytics.captureError(error);
    stellaToast.error(error.message);
  };
  const onSettled = async () => {
    await Promise.all([
      queryClient.resetQueries({
        queryKey: approvalQueueKeys.all({ organizationId, userId }),
      }),
      queryClient.invalidateQueries({
        queryKey: myTimeEntriesKeys.all(organizationId),
      }),
      queryClient.invalidateQueries({
        queryKey: timeEntriesKeys.root(),
      }),
    ]);
  };
  const approve = useMutation({
    mutationFn: approveTimeEntries,
    onError,
    onSettled,
  });
  const returnEntry = useMutation({
    mutationFn: returnTimeEntry,
    onError,
    onSettled,
  });
  return { approve, returnEntry };
};
