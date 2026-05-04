import { useQuery, useQueryClient } from "@tanstack/react-query";

import { useAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import { toSafeId } from "@/lib/safe-id";
import { aiAvailabilityOptions } from "@/routes/_protected.organization/-ai-config-queries";
import { workspaceKeys } from "@/routes/_protected.workspaces/$workspaceId/-queries/workspace";

/**
 * Returns a function that starts an AI extraction workflow via REST.
 * Replaces the old `useWorkflowActor().startWorkflow()` Rivet call.
 */
export const useStartWorkflow = (workspaceId: string) => {
  const queryClient = useQueryClient();
  const analytics = useAnalytics();
  const { data: aiAvailability } = useQuery(aiAvailabilityOptions);

  return async (args?: { entityIds?: string[]; entityIdsOrder?: string[] }) => {
    if (!aiAvailability?.available) {
      return undefined;
    }

    try {
      const response = await api
        .workspaces({ workspaceId: toSafeId<"workspace">(workspaceId) })
        .workflow.start.post({
          ...(args?.entityIds && {
            entityIds: args.entityIds.map((id) => toSafeId<"entity">(id)),
          }),
          ...(args?.entityIdsOrder && {
            entityIdsOrder: args.entityIdsOrder.map((id) =>
              toSafeId<"entity">(id),
            ),
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
