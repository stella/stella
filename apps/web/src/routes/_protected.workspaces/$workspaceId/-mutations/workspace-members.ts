import { usePostHog } from "@posthog/react";
import { useMutation } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { toAPIError } from "@/lib/errors";
import { captureError } from "@/lib/posthog/utils";
import { workspaceMembersKeys } from "@/routes/_protected.workspaces/$workspaceId/-queries/workspace-members";

type AddMemberVars = {
  workspaceId: string;
  userId: string;
};

export const useAddWorkspaceMember = () => {
  const posthog = usePostHog();

  return useMutation({
    mutationFn: async ({ workspaceId, userId }: AddMemberVars) => {
      const response = await api.workspaces({ workspaceId }).members.put({
        userId,
        queryKey: workspaceMembersKeys.all(workspaceId),
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

type RemoveMemberVars = {
  workspaceId: string;
  userId: string;
};

export const useRemoveWorkspaceMember = () => {
  const posthog = usePostHog();

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
      captureError(posthog, error);
    },
  });
};
