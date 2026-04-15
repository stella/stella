import { useQueryClient } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";

import { useAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import { workspaceKeys } from "@/routes/_protected.workspaces/$workspaceId/-queries/workspace";

/**
 * Returns a function that starts an AI extraction workflow via REST.
 * Replaces the old `useWorkflowActor().startWorkflow()` Rivet call.
 */
export const useStartWorkflow = () => {
  const queryClient = useQueryClient();
  const analytics = useAnalytics();
  const workspaceId = useParams({
    from: "/_protected/workspaces/$workspaceId",
    select: (s) => s.workspaceId,
  });

  return async (args?: { entityIds?: string[]; entityIdsOrder?: string[] }) => {
    try {
      const response = await api
        .workspaces({ workspaceId })
        .workflow.start.post({
          ...(args?.entityIds && { entityIds: args.entityIds }),
          ...(args?.entityIdsOrder && {
            entityIdsOrder: args.entityIdsOrder,
          }),
        });

      if (response.error) {
        analytics.captureError(new Error("Failed to start workflow"));
        return undefined;
      }

      // Invalidate workflow status so UI shows "running"
      await queryClient.invalidateQueries({
        queryKey: workspaceKeys.workflow(workspaceId),
      });

      return response.data;
    } catch (error) {
      analytics.captureError(error);
      return undefined;
    }
  };
};
