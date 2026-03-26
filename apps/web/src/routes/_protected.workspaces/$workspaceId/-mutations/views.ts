import { useMutation } from "@tanstack/react-query";

import { useAnalytics } from "@/lib/analytics/provider";
import type { ViewLayout, ViewLayoutType } from "@/lib/types";
import { useViewsActor } from "@/routes/_protected.workspaces/$workspaceId/-hooks/use-views-actor";

type CreateViewVars = {
  id: string;
  name: string;
  layout: ViewLayout;
};

export const useCreateView = (workspaceId: string) => {
  const analytics = useAnalytics();
  const actor = useViewsActor(workspaceId);

  return useMutation({
    mutationFn: async (body: CreateViewVars) =>
      await actor.handle?.createView(body),
    onError: (error) => {
      analytics.captureError(error);
    },
  });
};

type UpdateViewVars = {
  viewId: string;
  name?: string;
  layout?: ViewLayout;
};

export const useUpdateView = (workspaceId: string) => {
  const analytics = useAnalytics();
  const actor = useViewsActor(workspaceId);

  return useMutation({
    mutationFn: async (body: UpdateViewVars) =>
      await actor.handle?.updateView(body),
    onError: (error) => {
      analytics.captureError(error);
    },
  });
};

type ConvertViewVars = {
  viewId: string;
  targetType: ViewLayoutType;
};

export const useConvertView = (workspaceId: string) => {
  const analytics = useAnalytics();
  const actor = useViewsActor(workspaceId);

  return useMutation({
    mutationFn: async ({ viewId, targetType }: ConvertViewVars) =>
      await actor.handle?.convertView({ viewId, targetType }),
    onError: (error) => {
      analytics.captureError(error);
    },
  });
};

type ReorderViewsVars = {
  viewIds: string[];
};

export const useReorderViews = (workspaceId: string) => {
  const analytics = useAnalytics();
  const actor = useViewsActor(workspaceId);

  return useMutation({
    mutationFn: async ({ viewIds }: ReorderViewsVars) =>
      await actor.handle?.reorderViews({ viewIds }),
    onError: (error) => {
      analytics.captureError(error);
    },
  });
};

type DeleteViewVars = {
  viewId: string;
};

export const useDeleteView = (workspaceId: string) => {
  const analytics = useAnalytics();
  const actor = useViewsActor(workspaceId);

  return useMutation({
    mutationFn: async ({ viewId }: DeleteViewVars) =>
      await actor.handle?.deleteView({ viewId }),
    onError: (error) => {
      analytics.captureError(error);
    },
  });
};
