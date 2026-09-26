import { useMutation, useQueryClient } from "@tanstack/react-query";
import { panic } from "better-result";
import { useTranslations } from "use-intl";

import type { CorrespondenceHandlingState } from "@stll/api-contract/correspondence";
import { stellaToast } from "@stll/ui/toast";

import { useAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import { unwrapEden } from "@/lib/errors/api";
import { userErrorFromThrown } from "@/lib/errors/user-safe";
import { toSafeId } from "@/lib/safe-id";
import { correspondenceKeys } from "@/lib/workspaces/queries/correspondence";

type UpdateCorrespondenceVars = {
  workspaceId: string;
  correspondenceId: string;
} & (
  | { type: "set_handling"; handlingState: CorrespondenceHandlingState }
  | { type: "assign"; assigneeId: string | null }
);

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
      const endpoint = api
        .workspaces({ workspaceId })
        .correspondence({ correspondenceId });
      switch (body.type) {
        case "set_handling":
          return unwrapEden(
            await endpoint.patch({ handlingState: body.handlingState }),
          );
        case "assign":
          return unwrapEden(
            await endpoint.patch({
              assigneeId:
                body.assigneeId === null
                  ? null
                  : toSafeId<"user">(body.assigneeId),
            }),
          );
        default: {
          body satisfies never;
          return panic("Unhandled correspondence update command");
        }
      }
    },
    onSuccess: async (_result, { workspaceId }) => {
      await queryClient.invalidateQueries({
        queryKey: correspondenceKeys.all(workspaceId),
      });
    },
    onError: (error) => {
      analytics.captureError(error);
      stellaToast.add({
        title: userErrorFromThrown(error, t("common.error")),
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
        title: userErrorFromThrown(error, t("common.error")),
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
        title: userErrorFromThrown(error, t("common.error")),
        type: "error",
      });
    },
  });
};
