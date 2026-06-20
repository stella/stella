import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";

import { useAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import { toSafeId } from "@/lib/safe-id";
import { aiAvailabilityOptions } from "@/routes/_protected.organization/-ai-config-queries";
import { useWorkflowServiceTierPrompt } from "@/routes/_protected.workspaces/$workspaceId/-components/workflow-service-tier-prompt";
import { useWorkflowStartConfirmationPrompt } from "@/routes/_protected.workspaces/$workspaceId/-components/workflow-start-confirmation-prompt";
import {
  estimateWorkflowTargetCount,
  resolveWorkflowStartDecision,
  resolveWorkflowServiceTier,
} from "@/routes/_protected.workspaces/$workspaceId/-hooks/use-start-workflow.logic";
import type { StartWorkflowArgs } from "@/routes/_protected.workspaces/$workspaceId/-hooks/use-start-workflow.logic";
import { workspaceKeys } from "@/routes/_protected.workspaces/$workspaceId/-queries/workspace";

/**
 * Returns a function that starts an AI extraction workflow via REST.
 * Replaces the old `useWorkflowActor().startWorkflow()` Rivet call.
 */
export const useStartWorkflow = (workspaceId: string) => {
  const queryClient = useQueryClient();
  const analytics = useAnalytics();
  const activeOrganizationId = useRouteContext({
    from: "/_protected",
    select: (ctx) => ctx.user.activeOrganizationId,
  });
  const { data: aiAvailability } = useQuery(
    aiAvailabilityOptions({ organizationId: activeOrganizationId }),
  );
  const confirmLargeRun = useWorkflowStartConfirmationPrompt();
  const promptForServiceTier = useWorkflowServiceTierPrompt();

  return async (args?: StartWorkflowArgs) => {
    if (!aiAvailability?.available) {
      return undefined;
    }

    try {
      const entityCount = await estimateWorkflowTargetCount({
        args,
        queryClient,
        workspaceId,
      });
      const decision = await resolveWorkflowStartDecision({
        confirmLargeRun,
        estimateEntityCount: async () => await Promise.resolve(entityCount),
      });
      if (decision.type === "cancel") {
        return undefined;
      }

      const serviceTier = await resolveWorkflowServiceTier({
        args,
        deferredServiceTierAvailable:
          aiAvailability.deferredServiceTierAvailable,
        entityCount,
        promptForServiceTier,
      });

      const response = await api
        .workspaces({ workspaceId: toSafeId<"workspace">(workspaceId) })
        .workflow.start.post({
          ...(args?.entityIds !== undefined &&
            args.entityIds.length > 0 && {
              entityIds: args.entityIds.map((id) => toSafeId<"entity">(id)),
            }),
          ...(args?.entityIdsOrder !== undefined &&
            args.entityIdsOrder.length > 0 && {
              entityIdsOrder: args.entityIdsOrder.map((id) =>
                toSafeId<"entity">(id),
              ),
            }),
          ...(args?.propertyIds !== undefined &&
            args.propertyIds.length > 0 && {
              propertyIds: args.propertyIds.map((id) =>
                toSafeId<"property">(id),
              ),
            }),
          serviceTier,
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
