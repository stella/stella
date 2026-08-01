import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";

import {
  estimateWorkflowTargetCount,
  resolveWorkflowStartDecision,
  resolveWorkflowServiceTier,
} from "@/components/workspaces/hooks/use-start-workflow.logic";
import type { StartWorkflowArgs } from "@/components/workspaces/hooks/use-start-workflow.logic";
import { useWorkflowServiceTierPrompt } from "@/components/workspaces/workflow-service-tier-prompt";
import { useWorkflowStartConfirmationPrompt } from "@/components/workspaces/workflow-start-confirmation-prompt";
import { useAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import { aiAvailabilityOptions } from "@/lib/organization/ai-config-queries";
import { toSafeId } from "@/lib/safe-id";
import { workspaceKeys } from "@/lib/workspaces/queries/workspace";

/**
 * Returns a function that starts an AI extraction workflow via REST.
 */
export const useStartWorkflow = (workspaceId: string) => {
  const queryClient = useQueryClient();
  const analytics = useAnalytics();
  const activeOrganizationId = useRouteContext({
    from: "/_protected",
    select: (ctx) => ctx.user.activeOrganizationId,
  });
  const aiAvailabilityQuery = aiAvailabilityOptions({
    organizationId: activeOrganizationId,
  });
  const { data: aiAvailability } = useQuery(aiAvailabilityQuery);
  const confirmLargeRun = useWorkflowStartConfirmationPrompt();
  const promptForServiceTier = useWorkflowServiceTierPrompt();

  return async (args?: StartWorkflowArgs) => {
    try {
      const availability =
        aiAvailability ?? (await queryClient.fetchQuery(aiAvailabilityQuery));
      if (!availability.available) {
        return { status: "failed" } as const;
      }

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
        deferredServiceTierAvailable: availability.deferredServiceTierAvailable,
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
        return { status: "failed" } as const;
      }

      // Invalidate workflow status so UI shows "running"
      await queryClient.invalidateQueries({
        queryKey: workspaceKeys.workflow(workspaceId),
      });

      return response.data;
    } catch (error) {
      analytics.captureError(error);
      return { status: "failed" } as const;
    }
  };
};
