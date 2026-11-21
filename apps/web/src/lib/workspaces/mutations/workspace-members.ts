import { useQueryClient } from "@tanstack/react-query";

import { getTranslator } from "@/i18n/translator";
import { useAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import { unwrapApiResponse } from "@/lib/errors/api";
import { notifyUserError } from "@/lib/errors/user-toast";
import { useIdempotentMutation } from "@/lib/idempotency/use-idempotent-mutation";
import { toSafeId } from "@/lib/safe-id";
import { resourceMutation } from "@/lib/workspace-realtime";

type AddMemberVars = {
  workspaceId: string;
  userId: string;
};

export const useAddWorkspaceMember = () => {
  const analytics = useAnalytics();
  const queryClient = useQueryClient();

  return useIdempotentMutation({
    mutationFn: resourceMutation({
      mutation: "addWorkspaceMember",
      queryClient,
      mutationFn: async ({ workspaceId, userId }: AddMemberVars) => {
        const response = await api
          .workspaces({ workspaceId })
          .members.put({ userId: toSafeId<"user">(userId) });

        return unwrapApiResponse(response);
      },
    }),
    onError: (error) => {
      analytics.captureError(error, {
        fingerprintKey: "useAddWorkspaceMember:failure",
        scope: { type: "handler", handlerId: "useAddWorkspaceMember:failure" },
      });
      notifyUserError(error, getTranslator()("errors.actionFailed"));
    },
  });
};
