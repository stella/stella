import { usePostHog } from "@posthog/react";
import { useMutation } from "@tanstack/react-query";

import { captureError } from "@/lib/posthog/utils";
import type { ViewLayout, ViewLayoutType } from "@/lib/types";
import { useViewsActor } from "@/routes/_protected.workspaces/$workspaceId/-hooks/use-views-actor";

type CreateViewVars = {
  id: string;
  name: string;
  layout: ViewLayout;
};

export const useCreateView = (workspaceId: string) => {
  const posthog = usePostHog();
  const actor = useViewsActor(workspaceId);

  return useMutation({
    mutationFn: async (body: CreateViewVars) => {
      return await actor.handle?.createView(body);
    },
    onError: (error) => {
      captureError(posthog, error);
    },
  });
};

type UpdateViewVars = {
  viewId: string;
  name?: string;
  layout?: ViewLayout;
};

export const useUpdateView = (workspaceId: string) => {
  const posthog = usePostHog();
  const actor = useViewsActor(workspaceId);

  return useMutation({
    mutationFn: async (body: UpdateViewVars) => {
      return await actor.handle?.updateView(body);
    },
    onError: (error) => {
      captureError(posthog, error);
    },
  });
};

type ConvertViewVars = {
  viewId: string;
  targetType: ViewLayoutType;
};

export const useConvertView = (workspaceId: string) => {
  const posthog = usePostHog();
  const actor = useViewsActor(workspaceId);

  return useMutation({
    mutationFn: async ({ viewId, targetType }: ConvertViewVars) => {
      return await actor.handle?.convertView({ viewId, targetType });
    },
    onError: (error) => {
      captureError(posthog, error);
    },
  });
};

type ReorderViewsVars = {
  viewIds: string[];
};

export const useReorderViews = (workspaceId: string) => {
  const posthog = usePostHog();
  const actor = useViewsActor(workspaceId);

  return useMutation({
    mutationFn: async ({ viewIds }: ReorderViewsVars) => {
      return await actor.handle?.reorderViews({ viewIds });
    },
    onError: (error) => {
      captureError(posthog, error);
    },
  });
};

type DeleteViewVars = {
  viewId: string;
};

export const useDeleteView = (workspaceId: string) => {
  const posthog = usePostHog();
  const actor = useViewsActor(workspaceId);

  return useMutation({
    mutationFn: async ({ viewId }: DeleteViewVars) => {
      return await actor.handle?.deleteView({ viewId });
    },
    onError: (error) => {
      captureError(posthog, error);
    },
  });
};
