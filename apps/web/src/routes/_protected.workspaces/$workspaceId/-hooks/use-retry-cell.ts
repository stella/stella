import { useQueryClient } from "@tanstack/react-query";

import { useAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import { toSafeId } from "@/lib/safe-id";
import { entitiesKeys } from "@/routes/_protected.workspaces/$workspaceId/-queries/entities";
import { workspaceKeys } from "@/routes/_protected.workspaces/$workspaceId/-queries/workspace";

/**
 * Re-runs AI extraction for one cell (one entity × one property).
 * Resets the cell to `pending` on the server and enqueues a
 * workflow restricted to the target property only.
 */
export const useRetryCell = (workspaceId: string) => {
  const queryClient = useQueryClient();
  const analytics = useAnalytics();

  return async ({
    entityId,
    propertyId,
  }: {
    entityId: string;
    propertyId: string;
  }) => {
    try {
      const response = await api
        .workspaces({ workspaceId: toSafeId<"workspace">(workspaceId) })
        ["cell-retry"].post({
          entityId: toSafeId<"entity">(entityId),
          propertyId: toSafeId<"property">(propertyId),
        });

      if (response.error) {
        analytics.captureError(new Error("Failed to retry cell"));
        return undefined;
      }

      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: entitiesKeys.all(workspaceId),
        }),
        queryClient.invalidateQueries({
          queryKey: workspaceKeys.workflow(workspaceId),
        }),
      ]);

      return response.data;
    } catch (error) {
      analytics.captureError(error);
      return undefined;
    }
  };
};
