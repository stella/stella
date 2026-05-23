import { useMutation, useQueryClient } from "@tanstack/react-query";

import { useAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import { toAPIError } from "@/lib/errors";
import { toSafeId } from "@/lib/safe-id";
import type { ViewLayout } from "@/lib/types";
import { viewTemplateKeys } from "@/routes/_protected.workspaces/$workspaceId/-queries/view-templates";

type CreateViewTemplateVars = {
  workspaceId: string;
  name: string;
  layout: ViewLayout;
};

export const useCreateViewTemplate = () => {
  const analytics = useAnalytics();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ workspaceId, ...body }: CreateViewTemplateVars) => {
      const response = await api["view-templates"]({
        workspaceId: toSafeId<"workspace">(workspaceId),
      }).put(body);
      if (response.error) {
        throw toAPIError(response.error);
      }
      return { data: response.data, workspaceId };
    },
    onSuccess: ({ workspaceId }) => {
      // eslint-disable-next-line typescript/no-floating-promises
      queryClient.invalidateQueries({
        queryKey: viewTemplateKeys.all(workspaceId),
      });
    },
    onError: (error) => {
      analytics.captureError(error);
    },
  });
};

type DeleteViewTemplateVars = {
  workspaceId: string;
  templateId: string;
};

export const useDeleteViewTemplate = () => {
  const analytics = useAnalytics();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ workspaceId, templateId }: DeleteViewTemplateVars) => {
      const response = await api["view-templates"]({
        workspaceId: toSafeId<"workspace">(workspaceId),
      })({
        templateId: toSafeId<"workspaceViewTemplate">(templateId),
      }).delete();
      if (response.error) {
        throw toAPIError(response.error);
      }
      return { data: response.data, workspaceId };
    },
    onSuccess: ({ workspaceId }) => {
      // eslint-disable-next-line typescript/no-floating-promises
      queryClient.invalidateQueries({
        queryKey: viewTemplateKeys.all(workspaceId),
      });
    },
    onError: (error) => {
      analytics.captureError(error);
    },
  });
};
