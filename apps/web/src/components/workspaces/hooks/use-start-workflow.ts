import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import { stellaToast } from "@stll/ui/toast";

import {
  estimateWorkflowTargetCount,
  performWorkflowStart,
  resolveWorkflowStartDecision,
  resolveWorkflowServiceTier,
  WORKFLOW_START_AI_UNAVAILABLE,
  WORKFLOW_START_FAILED,
} from "@/components/workspaces/hooks/use-start-workflow.logic";
import type { StartWorkflowArgs } from "@/components/workspaces/hooks/use-start-workflow.logic";
import { useWorkflowServiceTierPrompt } from "@/components/workspaces/workflow-service-tier-prompt";
import { useWorkflowStartConfirmationPrompt } from "@/components/workspaces/workflow-start-confirmation-prompt";
import { useAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import { unwrapEden } from "@/lib/errors/api";
import { aiAvailabilityOptions } from "@/lib/organization/ai-config-queries";
import { toSafeId } from "@/lib/safe-id";
import { workspaceKeys } from "@/lib/workspaces/queries/workspace";

/**
 * Returns a function that starts an AI extraction workflow via REST.
 *
 * Most call sites start the workflow as a side effect of another action and
 * discard the answer, so a start that never reaches the queue is reported
 * here rather than handed back for a caller to notice.
 */
export const useStartWorkflow = (workspaceId: string) => {
  const t = useTranslations();
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

  const notifyStartFailed = () => {
    stellaToast.add({
      title: t("errors.failedToStartWorkflow"),
      type: "error",
    });
  };

  return async (args?: StartWorkflowArgs) => {
    try {
      const availability =
        aiAvailability ?? (await queryClient.query(aiAvailabilityQuery));
      if (!availability.available) {
        return WORKFLOW_START_AI_UNAVAILABLE;
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

      return await performWorkflowStart({
        captureError: (error) => {
          analytics.captureError(error);
        },
        notifyFailure: notifyStartFailed,
        // Invalidate workflow status so UI shows "running"
        onQueued: async () => {
          await queryClient.invalidateQueries({
            queryKey: workspaceKeys.workflow(workspaceId),
          });
        },
        request: async () =>
          unwrapEden(
            await api
              .workspaces({ workspaceId: toSafeId<"workspace">(workspaceId) })
              .workflow.start.post({
                ...(args?.entityIds !== undefined &&
                  args.entityIds.length > 0 && {
                    entityIds: args.entityIds.map((id) =>
                      toSafeId<"entity">(id),
                    ),
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
              }),
          ),
      });
    } catch (error) {
      // The prompts and the target-count estimate run before the request; a
      // failure here means nothing was started either.
      analytics.captureError(error);
      notifyStartFailed();
      return WORKFLOW_START_FAILED;
    }
  };
};
