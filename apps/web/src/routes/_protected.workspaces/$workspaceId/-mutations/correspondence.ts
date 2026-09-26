import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "use-intl";

import type { CorrespondenceHandlingState } from "@stll/api-contract/correspondence";
import { stellaToast } from "@stll/ui/toast";

import { useAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import { unwrapEden } from "@/lib/errors/api";
import { toSafeId } from "@/lib/safe-id";
import { correspondenceKeys } from "@/lib/workspaces/queries/correspondence";

type UpdateCorrespondenceVars = {
  workspaceId: string;
  correspondenceId: string;
  handlingState: CorrespondenceHandlingState;
  assigneeId: string | null;
};

export const useUpdateCorrespondence = () => {
  const analytics = useAnalytics();
  const queryClient = useQueryClient();
  const t = useTranslations();

  return useMutation({
    mutationFn: async ({
      workspaceId,
      correspondenceId,
      ...body
    }: UpdateCorrespondenceVars) => {
      const response = await api
        .workspaces({ workspaceId })
        .correspondence({ correspondenceId })
        .patch({
          handlingState: body.handlingState,
          assigneeId:
            body.assigneeId === null ? null : toSafeId<"user">(body.assigneeId),
        });
      return unwrapEden(response);
    },
    onSuccess: async (_result, { workspaceId }) => {
      await queryClient.invalidateQueries({
        queryKey: correspondenceKeys.all(workspaceId),
      });
    },
    onError: (error) => {
      analytics.captureError(error);
      stellaToast.add({
        title: error instanceof Error ? error.message : t("common.error"),
        type: "error",
      });
    },
  });
};

export const useRotateCorrespondenceAddress = () => {
  const analytics = useAnalytics();
  const queryClient = useQueryClient();
  const t = useTranslations();

  return useMutation({
    mutationFn: async ({ workspaceId }: { workspaceId: string }) => {
      const response = await api
        .workspaces({ workspaceId })
        .correspondence.address.post();
      return unwrapEden(response);
    },
    onSuccess: async (_result, { workspaceId }) => {
      await queryClient.invalidateQueries({
        queryKey: correspondenceKeys.address(workspaceId),
      });
    },
    onError: (error) => {
      analytics.captureError(error);
      stellaToast.add({
        title: error instanceof Error ? error.message : t("common.error"),
        type: "error",
      });
    },
  });
};

export const useRevokeCorrespondenceAddress = () => {
  const analytics = useAnalytics();
  const queryClient = useQueryClient();
  const t = useTranslations();

  return useMutation({
    mutationFn: async ({ workspaceId }: { workspaceId: string }) => {
      const response = await api
        .workspaces({ workspaceId })
        .correspondence.address.delete();
      return unwrapEden(response);
    },
    onSuccess: async (_result, { workspaceId }) => {
      await queryClient.invalidateQueries({
        queryKey: correspondenceKeys.address(workspaceId),
      });
    },
    onError: (error) => {
      analytics.captureError(error);
      stellaToast.add({
        title: error instanceof Error ? error.message : t("common.error"),
        type: "error",
      });
    },
  });
};
