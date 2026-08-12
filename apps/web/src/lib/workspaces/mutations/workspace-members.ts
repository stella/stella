import { useMutation, useQueryClient } from "@tanstack/react-query";

import { useAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import { detached } from "@/lib/detached";
import { unwrapEden } from "@/lib/errors/api";
import { toSafeId } from "@/lib/safe-id";
import { workspacesKeys } from "@/lib/workspaces/queries";
import { workspaceMembersKeys } from "@/lib/workspaces/queries/workspace-members";

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
      });

      return unwrapEden(response);
    },
    onSuccess: (_data, vars) => {
      detached(
        queryClient.invalidateQueries({
          queryKey: workspaceMembersKeys.all(vars.workspaceId),
        }),
        "workspace-members.invalidate",
      );
      detached(
        queryClient.invalidateQueries({ queryKey: workspacesKeys.all }),
        "workspace-members.invalidate",
      );
    },
    onError: (error) => {
      analytics.captureError(error);
    },
  });
};

export const workspaceMemberMutationInvalidationKeys = (
  workspaceId: string,
) => [workspaceMembersKeys.all(workspaceId), workspacesKeys.all];
