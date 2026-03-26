import { useMutation, useQueryClient } from "@tanstack/react-query";

import { useAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import { toAPIError } from "@/lib/errors";
import type { EntityKind } from "@/lib/types";
import type { EditableFieldContent } from "@/routes/_protected.workspaces/$workspaceId/-components/edit-field-dialog";
import { entitiesKeys } from "@/routes/_protected.workspaces/$workspaceId/-queries/entities";
import { workspacesKeys } from "@/routes/_protected.workspaces/-queries";

type CreateEntitiesVars =
  | {
      workspaceId: string;
      type: "file";
      version: 1;
      propertyId: string;
      entities: {
        id: string;
        fileId: string;
      }[];
    }
  | {
      type: "manual-input";
      workspaceId: string;
      kind?: EntityKind;
      parentId?: string | null;
      name?: string;
    };

export const useCreateEntities = () => {
  const analytics = useAnalytics();

  return useMutation({
    retry: 3,
    mutationFn: async ({ workspaceId, ...body }: CreateEntitiesVars) => {
      const response = await api.entities({ workspaceId }).put({
        queryKey: entitiesKeys.all(workspaceId),
        ...body,
      });

      if (response.error) {
        throw toAPIError(response.error);
      }

      return response.data;
    },
    onError: (error) => {
      analytics.captureError(error);
    },
  });
};

type DeleteEntitiesVars = {
  workspaceId: string;
  entityIds: string[];
};

export const useDeleteEntities = () => {
  const analytics = useAnalytics();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ workspaceId, entityIds }: DeleteEntitiesVars) => {
      const response = await api.entities({ workspaceId }).delete({
        queryKey: entitiesKeys.all(workspaceId),
        entityIds,
      });

      if (response.error) {
        throw toAPIError(response.error);
      }

      return response.data;
    },
    onSuccess: async (_data, { workspaceId }) => {
      await queryClient.invalidateQueries({
        queryKey: workspacesKeys.overview(workspaceId),
      });
    },
    onError: (error) => {
      analytics.captureError(error);
    },
  });
};

type MoveEntityVars = {
  workspaceId: string;
  entityId: string;
  parentId: string | null;
};

export const useMoveEntity = () => {
  const analytics = useAnalytics();

  return useMutation({
    mutationFn: async ({ workspaceId, entityId, parentId }: MoveEntityVars) => {
      const response = await api.entities({ workspaceId }).move.patch({
        queryKey: entitiesKeys.all(workspaceId),
        entityId,
        parentId,
      });

      if (response.error) {
        throw toAPIError(response.error);
      }

      return response.data;
    },
    onError: (error) => {
      analytics.captureError(error);
    },
  });
};

type RenameEntityVars = {
  workspaceId: string;
  entityId: string;
  name: string;
};

export const useRenameEntity = () => {
  const analytics = useAnalytics();

  return useMutation({
    mutationFn: async ({ workspaceId, entityId, name }: RenameEntityVars) => {
      const response = await api.entities({ workspaceId }).rename.patch({
        queryKey: entitiesKeys.all(workspaceId),
        entityId,
        name,
      });

      if (response.error) {
        throw toAPIError(response.error);
      }

      return response.data;
    },
    onError: (error) => {
      analytics.captureError(error);
    },
  });
};

type UpsertFieldVars = {
  workspaceId: string;
  propertyId: string;
  entityId: string;
  content: EditableFieldContent;
};

export const useUpsertField = () => {
  const analytics = useAnalytics();

  return useMutation({
    mutationFn: async ({
      workspaceId,
      propertyId,
      entityId,
      content,
    }: UpsertFieldVars) => {
      const response = await api.fields({ workspaceId }).post({
        queryKey: entitiesKeys.all(workspaceId),
        propertyId,
        entityId,
        content,
      });

      if (response.error) {
        throw toAPIError(response.error);
      }

      return response.data;
    },

    onError: (error) => {
      analytics.captureError(error);
    },
  });
};
