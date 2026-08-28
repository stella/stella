import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "use-intl";

import type { UpsertFieldContent } from "@stll/api/types";
import { stellaToast } from "@stll/ui/toast";

import { closeInspectorTabsForEntities } from "@/components/inspector/inspector-tabs-store";
import { useAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import { unwrapEden } from "@/lib/errors/api";
import { toSafeId } from "@/lib/safe-id";
import type { EntityKind } from "@/lib/types";
import { invalidateDeletedEntityQueries } from "@/lib/workspaces/mutations/entities.logic";

type CreateEntitiesVars = {
  type: "manual-input";
  workspaceId: string;
  kind?: EntityKind;
  parentId?: string | null;
  name: string;
};

export const useCreateEntities = () => {
  const analytics = useAnalytics();

  return useMutation({
    mutationFn: async ({ workspaceId, ...body }: CreateEntitiesVars) => {
      const response = await api
        .entities({ workspaceId: toSafeId<"workspace">(workspaceId) })
        .put({
          name: body.name,
          ...(body.kind !== undefined && { kind: body.kind }),
          ...(body.parentId !== undefined && {
            parentId:
              body.parentId === null ? null : toSafeId<"entity">(body.parentId),
          }),
        });

      return unwrapEden(response);
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
      const response = await api
        .entities({ workspaceId: toSafeId<"workspace">(workspaceId) })
        .delete({
          entityIds: entityIds.map((entityId) => toSafeId<"entity">(entityId)),
        });

      return unwrapEden(response);
    },
    onSuccess: async (_data, { workspaceId, entityIds }) => {
      closeInspectorTabsForEntities(entityIds);
      await invalidateDeletedEntityQueries({
        queryClient,
        workspaceId,
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
      const response = await api
        .entities({ workspaceId: toSafeId<"workspace">(workspaceId) })
        .move.patch({
          entityId: toSafeId<"entity">(entityId),
          parentId: parentId === null ? null : toSafeId<"entity">(parentId),
        });

      return unwrapEden(response);
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
  const t = useTranslations();

  return useMutation({
    mutationFn: async ({ workspaceId, entityId, name }: RenameEntityVars) => {
      const response = await api
        .entities({ workspaceId: toSafeId<"workspace">(workspaceId) })
        .rename.patch({
          entityId: toSafeId<"entity">(entityId),
          name,
        });

      return unwrapEden(response);
    },
    onError: (error) => {
      analytics.captureError(error);
      stellaToast.add({
        title: t("errors.actionFailed"),
        type: "error",
      });
    },
  });
};

type UpsertFieldVars = {
  workspaceId: string;
  propertyId: string;
  entityId: string;
  content: UpsertFieldContent;
};

type UpdateKanbanPlacementVars = {
  workspaceId: string;
  entityId: string;
  status?: string | undefined;
  fields: {
    propertyId: string;
    content: UpsertFieldContent;
  }[];
};

export const useUpdateKanbanPlacement = () => {
  const analytics = useAnalytics();
  const t = useTranslations();

  return useMutation({
    mutationFn: async ({
      workspaceId,
      entityId,
      status,
      fields,
    }: UpdateKanbanPlacementVars) => {
      const response = await api
        .fields({ workspaceId: toSafeId<"workspace">(workspaceId) })
        ["kanban-placement"].patch({
          entityId: toSafeId<"entity">(entityId),
          ...(status !== undefined && { status }),
          fields: fields.map(({ propertyId, content }) => ({
            propertyId: toSafeId<"property">(propertyId),
            content,
          })),
        });

      return unwrapEden(response);
    },
    onError: (error) => {
      analytics.captureError(error);
      stellaToast.add({
        title: t("errors.actionFailed"),
        type: "error",
      });
    },
  });
};

export const useUpsertField = () => {
  const analytics = useAnalytics();
  const t = useTranslations();

  return useMutation({
    mutationFn: async ({
      workspaceId,
      propertyId,
      entityId,
      content,
    }: UpsertFieldVars) => {
      const response = await api
        .fields({ workspaceId: toSafeId<"workspace">(workspaceId) })
        .post({
          propertyId: toSafeId<"property">(propertyId),
          entityId: toSafeId<"entity">(entityId),
          content,
        });

      return unwrapEden(response);
    },

    onError: (error) => {
      analytics.captureError(error);
      stellaToast.add({
        title: t("errors.actionFailed"),
        type: "error",
      });
    },
  });
};
