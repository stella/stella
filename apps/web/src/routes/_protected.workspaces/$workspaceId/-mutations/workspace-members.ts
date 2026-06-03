import { useMutation, useQueryClient } from "@tanstack/react-query";

import { useAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import { toAPIError } from "@/lib/errors";
import { toSafeId } from "@/lib/safe-id";
import { workspaceMembersKeys } from "@/routes/_protected.workspaces/$workspaceId/-queries/workspace-members";
import { workspacesKeys } from "@/routes/_protected.workspaces/-queries";

type AddMemberVars = {
  workspaceId: string;
  userId: string;
};

export const useAddWorkspaceMember = () => {
  const analytics = useAnalytics();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ workspaceId, userId }: AddMemberVars) => {
      const response = await api.workspaces({ workspaceId }).members.put({
        userId: toSafeId<"user">(userId),
        queryKey: workspacesKeys.all,
      });

      if (response.error) {
        throw toAPIError(response.error);
      }

      return response.data;
    },
    onSuccess: (_data, vars) => {
      void queryClient.invalidateQueries({
        queryKey: workspaceMembersKeys.all(vars.workspaceId),
      });
      void queryClient.invalidateQueries({ queryKey: workspacesKeys.all });
    },
    onError: (error) => {
      analytics.captureError(error);
    },
  });
};

export const workspaceMemberMutationInvalidationKeys = (
  workspaceId: string,
) => [workspaceMembersKeys.all(workspaceId), workspacesKeys.all];
