import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "use-intl";

import { stellaToast } from "@stll/ui/components/toast";

import { useAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import { unwrapEden } from "@/lib/errors/api";
import { userErrorFromThrown } from "@/lib/errors/user-safe";
import type { EntityId, FieldId, WorkspaceId } from "@/lib/types";
import { entitiesKeys } from "@/routes/_protected.workspaces/$workspaceId/-queries/entities";

type RunOcrArgs = {
  workspaceId: WorkspaceId;
  entityId: EntityId;
  fieldId: FieldId;
};

export const useRunOcr = () => {
  const analytics = useAnalytics();
  const queryClient = useQueryClient();
  const t = useTranslations();

  return useMutation({
    mutationFn: async ({ workspaceId, entityId, fieldId }: RunOcrArgs) =>
      unwrapEden(
        await api
          .entities({ workspaceId })
          .entity({ entityId })
          .ocr.post({ fieldId }),
      ),
    onSuccess: async (_, { workspaceId }) => {
      await queryClient.invalidateQueries({
        queryKey: entitiesKeys.all(workspaceId),
      });
      stellaToast.add({
        title: t("workspaces.files.ocrQueued"),
        type: "success",
      });
    },
    onError: (error) => {
      analytics.captureError(error);
      stellaToast.add({
        title: t("workspaces.files.ocrQueueFailed"),
        description: userErrorFromThrown(error, t("errors.actionFailed")),
        type: "error",
      });
    },
  });
};
