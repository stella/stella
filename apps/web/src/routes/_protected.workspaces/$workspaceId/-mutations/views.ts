import { usePostHog } from "@posthog/react";
import { useMutation } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { toAPIError } from "@/lib/errors";
import { captureError } from "@/lib/posthog/utils";
import type { ViewConfig, ViewLayout } from "@/lib/types";
import { viewsKeys } from "@/routes/_protected.workspaces/$workspaceId/-queries/views";

type CreateViewVars = {
  workspaceId: string;
  id: string;
  name: string;
  layout: ViewLayout;
  config: ViewConfig;
};

export const useCreateView = () => {
  const posthog = usePostHog();

  return useMutation({
    mutationFn: async ({ workspaceId, ...body }: CreateViewVars) => {
      const response = await api.views({ workspaceId }).put({
        queryKey: viewsKeys.all(workspaceId),
        ...body,
      });

      if (response.error) {
        throw toAPIError(response.error);
      }

      return response.data;
    },
    onError: (error) => {
      captureError(posthog, error);
    },
  });
};

type UpdateViewVars = {
  workspaceId: string;
  viewId: string;
  name?: string;
  layout?: ViewLayout;
  config?: ViewConfig;
};

export const useUpdateView = () => {
  const posthog = usePostHog();

  return useMutation({
    mutationFn: async ({ workspaceId, viewId, ...body }: UpdateViewVars) => {
      const response = await api
        .views({ workspaceId })
        .view({ viewId })
        .post({
          queryKey: viewsKeys.all(workspaceId),
          ...body,
        });

      if (response.error) {
        throw toAPIError(response.error);
      }

      return response.data;
    },
    onError: (error) => {
      captureError(posthog, error);
    },
  });
};

type ReorderViewsVars = {
  workspaceId: string;
  viewIds: string[];
};

export const useReorderViews = () => {
  const posthog = usePostHog();

  return useMutation({
    mutationFn: async ({ workspaceId, viewIds }: ReorderViewsVars) => {
      const response = await api.views({ workspaceId }).reorder.patch({
        queryKey: viewsKeys.all(workspaceId),
        viewIds,
      });

      if (response.error) {
        throw toAPIError(response.error);
      }

      return response.data;
    },
    onError: (error) => {
      captureError(posthog, error);
    },
  });
};

type DeleteViewVars = {
  workspaceId: string;
  viewId: string;
};

export const useDeleteView = () => {
  const posthog = usePostHog();

  return useMutation({
    mutationFn: async ({ workspaceId, viewId }: DeleteViewVars) => {
      const response = await api
        .views({ workspaceId })
        .view({ viewId })
        .delete({
          queryKey: viewsKeys.all(workspaceId),
        });

      if (response.error) {
        throw toAPIError(response.error);
      }

      return response.data;
    },
    onError: (error) => {
      captureError(posthog, error);
    },
  });
};
