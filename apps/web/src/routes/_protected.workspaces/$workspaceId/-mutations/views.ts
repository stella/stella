import { useMutation, useQueryClient } from "@tanstack/react-query";

import { useAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import { toAPIError } from "@/lib/errors";
import { toSafeId } from "@/lib/safe-id";
import type {
  ViewLayout,
  ViewLayoutType,
  ViewTemplateProperty,
  WorkspaceView,
} from "@/lib/types";
import { propertiesKeys } from "@/routes/_protected.workspaces/$workspaceId/-queries/properties";
import { viewsKeys } from "@/routes/_protected.workspaces/$workspaceId/-queries/views";

type CreateViewVars = {
  id: string;
  name: string;
  layout: ViewLayout;
  templateProperties?: ViewTemplateProperty[];
};

export const useCreateView = (workspaceId: string) => {
  const analytics = useAnalytics();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (body: CreateViewVars) => {
      const response = await api
        .views({ workspaceId: toSafeId<"workspace">(workspaceId) })
        .put({ ...body, id: toSafeId<"workspaceView">(body.id) });
      if (response.error) {
        throw toAPIError(response.error);
      }
      return response.data;
    },
    onSuccess: async (_data, variables) => {
      const invalidations = [
        queryClient.invalidateQueries({
          queryKey: viewsKeys.all(workspaceId),
        }),
      ];
      // Applying a template can create properties in this matter.
      // Without invalidating, the table renders with a stale property
      // list and TanStack silently strips the new column IDs from the
      // newly-created view's columnOrder on the next layout update.
      if (
        variables.templateProperties &&
        variables.templateProperties.length > 0
      ) {
        invalidations.push(
          queryClient.invalidateQueries({
            queryKey: propertiesKeys.all(workspaceId),
          }),
        );
      }
      await Promise.all(invalidations);
    },
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
  const queryClient = useQueryClient();
  const queryKey = viewsKeys.all(workspaceId);

  return useMutation({
    mutationFn: async ({ viewId, ...body }: UpdateViewVars) => {
      const response = await api
        .views({ workspaceId: toSafeId<"workspace">(workspaceId) })
        .view({ viewId: toSafeId<"workspaceView">(viewId) })
        .post(body);
      if (response.error) {
        throw toAPIError(response.error);
      }
      return response.data;
    },
    onMutate: async ({ viewId, ...body }) => {
      await queryClient.cancelQueries({ queryKey });
      const previousViews = queryClient.getQueryData<WorkspaceView[]>(queryKey);

      queryClient.setQueryData<WorkspaceView[]>(
        queryKey,
        (current): WorkspaceView[] | undefined => {
          if (!current) {
            return current;
          }
          return current.map((view) =>
            view.id === viewId
              ? {
                  ...view,
                  ...(body.name !== undefined && { name: body.name }),
                  ...(body.layout !== undefined && { layout: body.layout }),
                }
              : view,
          );
        },
      );

      return { previousViews };
    },
    onError: (error, _variables, context) => {
      if (context?.previousViews) {
        queryClient.setQueryData(queryKey, context.previousViews);
      }
      analytics.captureError(error);
    },
    onSettled: async () => {
      await queryClient.invalidateQueries({ queryKey });
    },
  });
};

type ConvertViewVars = {
  viewId: string;
  targetType: ViewLayoutType;
};

export const useConvertView = (workspaceId: string) => {
  const analytics = useAnalytics();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ viewId, targetType }: ConvertViewVars) => {
      const response = await api
        .views({ workspaceId: toSafeId<"workspace">(workspaceId) })
        .view({ viewId: toSafeId<"workspaceView">(viewId) })
        .convert.post({ targetType });
      if (response.error) {
        throw toAPIError(response.error);
      }
      return response.data;
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: viewsKeys.all(workspaceId),
      });
    },
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
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ viewIds }: ReorderViewsVars) => {
      const response = await api
        .views({ workspaceId: toSafeId<"workspace">(workspaceId) })
        .reorder.post({
          viewIds: viewIds.map((viewId) => toSafeId<"workspaceView">(viewId)),
        });
      if (response.error) {
        throw toAPIError(response.error);
      }
      return response.data;
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: viewsKeys.all(workspaceId),
      });
    },
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
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ viewId }: DeleteViewVars) => {
      const response = await api
        .views({ workspaceId: toSafeId<"workspace">(workspaceId) })
        .view({ viewId: toSafeId<"workspaceView">(viewId) })
        .delete();
      if (response.error) {
        throw toAPIError(response.error);
      }
      return response.data;
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: viewsKeys.all(workspaceId),
      });
    },
    onError: (error) => {
      analytics.captureError(error);
    },
  });
};
