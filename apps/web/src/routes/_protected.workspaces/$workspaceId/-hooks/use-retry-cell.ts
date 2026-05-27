import { useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "use-intl";

import { stellaToast } from "@stll/ui/components/toast";

import { useAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import { userErrorMessage } from "@/lib/errors";
import { toSafeId } from "@/lib/safe-id";
import { entitiesKeys } from "@/routes/_protected.workspaces/$workspaceId/-queries/entities";
import { workspaceKeys } from "@/routes/_protected.workspaces/$workspaceId/-queries/workspace";

/**
 * Re-runs AI extraction for one cell (one entity × one property).
 * Enqueues a workflow restricted to the target property only; the
 * worker itself moves the cell into `pending` and writes the result.
 */
export const useRetryCell = (workspaceId: string) => {
  const queryClient = useQueryClient();
  const analytics = useAnalytics();
  const t = useTranslations();

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
        // Surface server-side rejections (locked cell, concurrent
        // workflow, read-only entity) — without this the user just
        // sees the menu close and nothing happens. `userErrorMessage`
        // hides 5xx detail behind a generic fallback.
        stellaToast.add({
          title: userErrorMessage(response.error, t("errors.actionFailed")),
          type: "error",
        });
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
      stellaToast.add({
        title: t("errors.actionFailed"),
        type: "error",
      });
      return undefined;
    }
  };
};
