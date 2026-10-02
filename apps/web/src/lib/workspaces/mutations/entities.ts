import type { QueryClient } from "@tanstack/react-query";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Result } from "better-result";
import { useTranslations } from "use-intl";

import { stellaToast } from "@stll/ui/toast";

import {
  closeInspectorTabsForEntities,
  useInspectorTabsStore,
} from "@/components/inspector/inspector-tabs-store";
import { useAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import type { UpsertFieldContent } from "@/lib/api-contract";
import { unwrapEden } from "@/lib/errors/api";
import { fileMetadataByFieldQueryRoot } from "@/lib/files/file-metadata-query.logic";
import { toSafeId } from "@/lib/safe-id";
import type { EntityKind } from "@/lib/types";
import { invalidateDeletedEntityQueries } from "@/lib/workspaces/mutations/entities.logic";
import { entitiesKeys } from "@/lib/workspaces/queries/entities.logic";

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

type RenameEntityCompletion = {
  onSuccess?: () => void;
  onError?: (error: Error) => void;
};

type RenameEntityInvocation = RenameEntityVars & {
  completion?: RenameEntityCompletion;
};

// Shared across observers, but isolated to the query client's session.
const renameQueues = new WeakMap<QueryClient, Map<string, Promise<void>>>();

export const useRenameEntity = () => {
  const analytics = useAnalytics();
  const t = useTranslations();
  const queryClient = useQueryClient();
  const reportFailure = (error: unknown) => {
    analytics.captureError(error);
    stellaToast.add({ title: t("errors.actionFailed"), type: "error" });
  };

  const mutation = useMutation({
    onMutate: async ({
      workspaceId,
      entityId,
      name,
    }: RenameEntityInvocation) => {
      let queues = renameQueues.get(queryClient);
      if (!queues) {
        queues = new Map();
        renameQueues.set(queryClient, queues);
      }
      const key = JSON.stringify([workspaceId, entityId]);
      const previous = queues.get(key);
      const gate = Promise.withResolvers<undefined>();
      queues.set(key, gate.promise);
      await previous;
      const store = useInspectorTabsStore.getState();
      const tabs = store.tabs.flatMap((tab) =>
        tab.type === "pdf" &&
        tab.workspaceId === workspaceId &&
        tab.entityId === entityId
          ? [{ id: tab.id, label: tab.label, fileName: tab.fileName }]
          : [],
      );
      for (const tab of tabs) {
        store.updateLabel(tab.id, name);
      }
      return {
        tabs,
        release: () => {
          if (queues.get(key) === gate.promise) {
            queues.delete(key);
          }
          gate.resolve(undefined);
        },
      };
    },
    mutationFn: async ({
      workspaceId,
      entityId,
      name,
    }: RenameEntityInvocation) => {
      const response = await api
        .entities({ workspaceId: toSafeId<"workspace">(workspaceId) })
        .rename.patch({ entityId: toSafeId<"entity">(entityId), name });
      return unwrapEden(response);
    },
    onSuccess: async (data, { workspaceId, entityId }) => {
      const store = useInspectorTabsStore.getState();
      for (const tab of store.tabs) {
        if (
          tab.type !== "pdf" ||
          tab.workspaceId !== workspaceId ||
          tab.entityId !== entityId ||
          !data.file
        ) {
          continue;
        }
        store.updateFileMetadata(tab.id, {
          label: data.name,
          fileName: data.file.fileName,
        });
      }
      const refreshed = await Result.tryPromise(
        async () =>
          await Promise.all([
            queryClient.invalidateQueries({
              queryKey: entitiesKeys.all(workspaceId),
            }),
            ...(data.file
              ? [
                  queryClient.invalidateQueries({
                    queryKey: fileMetadataByFieldQueryRoot({
                      workspaceId,
                      fieldId: data.file.fieldId,
                    }),
                  }),
                ]
              : []),
          ]),
      );
      // A refresh failure cannot roll back metadata already committed by the server.
      if (refreshed.isErr()) {
        reportFailure(refreshed.error);
      }
    },
    onError: (error, _variables, context) => {
      const store = useInspectorTabsStore.getState();
      for (const tab of context?.tabs ?? []) {
        store.updateFileMetadata(tab.id, tab);
      }
      reportFailure(error);
    },
    onSettled: (_data, error, { completion }, context) => {
      context?.release();
      const completed = Result.try(() => {
        if (error !== null) {
          completion?.onError?.(error);
          return;
        }
        completion?.onSuccess?.();
      });
      if (completed.isErr()) {
        reportFailure(completed.error);
      }
    },
  });

  // Observer callbacks only run for the latest invocation. Carry completion
  // handlers in the variables so every mutation owns its settlement instead.
  return {
    ...mutation,
    mutate: (
      variables: RenameEntityVars,
      completion?: RenameEntityCompletion,
    ) =>
      mutation.mutate({ ...variables, ...(completion ? { completion } : {}) }),
    mutateAsync: (
      variables: RenameEntityVars,
      completion?: RenameEntityCompletion,
    ) =>
      mutation.mutateAsync({
        ...variables,
        ...(completion ? { completion } : {}),
      }),
  };
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
