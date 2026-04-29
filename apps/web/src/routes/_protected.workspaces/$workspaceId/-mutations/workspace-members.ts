import { useMutation } from "@tanstack/react-query";

import { useAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import { toAPIError } from "@/lib/errors";
import { toSafeId } from "@/lib/safe-id";
import { workspaceMembersKeys } from "@/routes/_protected.workspaces/$workspaceId/-queries/workspace-members";

type AddMemberVars = {
  workspaceId: string;
  userId: string;
};

export const useAddWorkspaceMember = () => {
  const analytics = useAnalytics();

  return useMutation({
    mutationFn: async ({ workspaceId, userId }: AddMemberVars) => {
      const response = await api.workspaces({ workspaceId }).members.put({
        userId: toSafeId<"user">(userId),
        queryKey: workspaceMembersKeys.all(workspaceId),
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

type RemoveMemberVars = {
  workspaceId: string;
  userId: string;
};

export const useRemoveWorkspaceMember = () => {
  const analytics = useAnalytics();

  return useMutation({
    mutationFn: async ({ workspaceId, userId }: RemoveMemberVars) => {
      const response = await api
        .workspaces({ workspaceId })
        .members({ userId })
        .delete({
          queryKey: workspaceMembersKeys.all(workspaceId),
        });

      if (response.error) {
        throw toAPIError(response.error);
      }
    },
    onError: (error) => {
      analytics.captureError(error);
    },
  });
};
