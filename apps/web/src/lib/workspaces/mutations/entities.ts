import type { QueryClient } from "@tanstack/react-query";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { panic, Result } from "better-result";
import { useTranslations } from "use-intl";
import type { StoreApi } from "zustand";

import type { InspectorTabsStore } from "@/components/inspector/inspector-store-types";
import {
  closeInspectorTabsForEntities,
  useInspectorTabsStore,
} from "@/components/inspector/inspector-tabs-store";
import { getTranslator } from "@/i18n/translator";
import type { ExceptionFingerprintKey } from "@/lib/analytics/exception-fingerprint";
import { useAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import type { UpsertFieldContent } from "@/lib/api-contract";
import { useAuthenticatedUser } from "@/lib/authenticated-user-context";
import { invokeCapability } from "@/lib/capabilities/capability-request";
import { detached } from "@/lib/detached";
import { unwrapApiResponse } from "@/lib/errors/api";
import { notifyUserError } from "@/lib/errors/user-toast";
import { fileMetadataByFieldQueryRoot } from "@/lib/files/file-metadata-query.logic";
import { replaceCachedFileName } from "@/lib/files/queries";
import { inboxKeys } from "@/lib/inbox/queries";
import { toSafeId } from "@/lib/safe-id";
import type { EntityKind } from "@/lib/types";
import {
  invalidateDeletedEntityQueries,
  invalidateRenamedEntityQueries,
} from "@/lib/workspaces/mutations/entities.logic";
import { entityViewKeys } from "@/lib/workspaces/queries/entity-views";

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

      return unwrapApiResponse(response);
    },
    onError: (error) => {
      analytics.captureError(error, {
        fingerprintKey: "useCreateEntities:failure",
        scope: { type: "handler", handlerId: "useCreateEntities:failure" },
      });
      notifyUserError(error, getTranslator()("errors.actionFailed"));
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

      return unwrapApiResponse(response);
    },
    onSuccess: async (_data, { workspaceId, entityIds }) => {
      closeInspectorTabsForEntities(entityIds);
      await invalidateDeletedEntityQueries({
        queryClient,
        workspaceId,
        entityIds,
      });
    },
    onError: (error) => {
      analytics.captureError(error, {
        fingerprintKey: "useDeleteEntities:failure",
        scope: { type: "handler", handlerId: "useDeleteEntities:failure" },
      });
      notifyUserError(error, getTranslator()("errors.actionFailed"));
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

      return unwrapApiResponse(response);
    },
    onError: (error) => {
      analytics.captureError(error, {
        fingerprintKey: "useMoveEntity:failure",
        scope: { type: "handler", handlerId: "useMoveEntity:failure" },
      });
      notifyUserError(error, getTranslator()("errors.actionFailed"));
    },
  });
};

type CreateFolderFromSelectionVars = {
  workspaceId: string;
  name: string;
  parentId: string | null;
  entityIds: readonly string[];
};

export const useCreateFolderFromSelection = () => {
  const analytics = useAnalytics();

  return useMutation({
    mutationFn: async ({
      workspaceId,
      name,
      parentId,
      entityIds,
    }: CreateFolderFromSelectionVars) =>
      await invokeCapability(
        "entities.folder-from-selection.create",
        async (request) => {
          const entitiesRoute = api.entities({
            workspaceId: toSafeId<"workspace">(workspaceId),
          });
          const response = await entitiesRoute["folder-from-selection"].post(
            {
              name,
              parentId: parentId === null ? null : toSafeId<"entity">(parentId),
              entityIds: entityIds.map((entityId) =>
                toSafeId<"entity">(entityId),
              ),
            },
            request,
          );
          return unwrapApiResponse(response);
        },
      ),
    onError: (error) => {
      analytics.captureError(error, {
        fingerprintKey: "useCreateFolderFromSelection:failure",
        scope: {
          type: "handler",
          handlerId: "entities.folder-from-selection.create",
        },
      });
      notifyUserError(error, getTranslator()("errors.actionFailed"));
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

export const useRenameEntity = (
  inspectorStore?: StoreApi<InspectorTabsStore>,
) => {
  const { activeOrganizationId, id: userId } = useAuthenticatedUser();
  return useRenameEntityForUser({
    activeOrganizationId,
    inspectorStore,
    userId,
  });
};

type RenameEntityForUserOptions = {
  activeOrganizationId: string;
  inspectorStore: StoreApi<InspectorTabsStore> | undefined;
  userId: string;
};

export const useRenameEntityForUser = (options: RenameEntityForUserOptions) => {
  const { activeOrganizationId, inspectorStore, userId } = options;
  const analytics = useAnalytics();
  const t = useTranslations();
  const queryClient = useQueryClient();
  const notifyRenameFailure = (
    error: unknown,
    fingerprintKey: ExceptionFingerprintKey,
  ) => {
    analytics.captureError(error, {
      fingerprintKey,
      scope: { type: "handler", handlerId: fingerprintKey },
    });
    notifyUserError(error, t("errors.actionFailed"));
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
      const release = () => {
        if (queues.get(key) === gate.promise) {
          queues.delete(key);
        }
        gate.resolve(undefined);
      };
      const optimistic = await Result.tryPromise(async () => {
        await previous;
        const store = inspectorStore
          ? inspectorStore.getState()
          : useInspectorTabsStore.getState();
        const previousLabel = store.tabs.find(
          (tab) =>
            tab.type === "pdf" &&
            tab.workspaceId === workspaceId &&
            tab.entityId === entityId,
        )?.label;
        for (const tab of store.tabs) {
          if (
            tab.type === "pdf" &&
            tab.workspaceId === workspaceId &&
            tab.entityId === entityId
          ) {
            store.updateLabel(tab.id, name);
          }
        }
        return { previousLabel, release };
      });
      if (optimistic.isErr()) {
        release();
        panic("Inspector optimistic rename failed", optimistic.error);
      }
      return optimistic.value;
    },
    mutationFn: async ({
      workspaceId,
      entityId,
      name,
    }: RenameEntityInvocation) => {
      const response = await api
        .entities({ workspaceId: toSafeId<"workspace">(workspaceId) })
        .rename.patch({ entityId: toSafeId<"entity">(entityId), name });
      return unwrapApiResponse(response);
    },
    onSuccess: (data, { workspaceId, entityId }, context) => {
      const reconciled = Result.try(() => {
        const store = inspectorStore
          ? inspectorStore.getState()
          : useInspectorTabsStore.getState();
        for (const tab of store.tabs) {
          if (
            tab.type !== "pdf" ||
            tab.workspaceId !== workspaceId ||
            tab.entityId !== entityId
          ) {
            continue;
          }
          if (data.file && tab.id === data.file.fieldId) {
            store.updateFileMetadata(tab.id, {
              label: data.name,
              fileName: data.file.fileName,
            });
            continue;
          }
          store.updateLabel(tab.id, data.name);
        }
      });
      if (reconciled.isErr()) {
        analytics.captureError(reconciled.error, {
          fingerprintKey: "useRenameEntity:failure",
          scope: { type: "handler", handlerId: "useRenameEntity:failure" },
        });
      }
      if (data.file) {
        replaceCachedFileName(queryClient, {
          fieldId: data.file.fieldId,
          fileName: data.file.fileName,
          workspaceId,
        });
      }
      context.release();
      // Refetches repair caches independently of the committed mutation's settlement.
      detached(
        (async () => {
          await Promise.all([
            invalidateRenamedEntityQueries({
              queryClient,
              workspaceId,
              entityId,
            }),
            queryClient.invalidateQueries({
              queryKey: entityViewKeys.all(activeOrganizationId, userId),
            }),
            queryClient.invalidateQueries({
              queryKey: inboxKeys.all(activeOrganizationId, userId),
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
          ]);
        })(),
        "entity-rename.refresh",
      );
    },
    onError: (error, { workspaceId, entityId, name }, context) => {
      const rolledBack = Result.try(() => {
        if (context?.previousLabel === undefined) {
          return;
        }
        const store = inspectorStore
          ? inspectorStore.getState()
          : useInspectorTabsStore.getState();
        for (const tab of store.tabs) {
          if (
            tab.type === "pdf" &&
            tab.workspaceId === workspaceId &&
            tab.entityId === entityId &&
            tab.label === name
          ) {
            store.updateLabel(tab.id, context.previousLabel);
          }
        }
      });
      if (rolledBack.isErr()) {
        analytics.captureError(rolledBack.error, {
          fingerprintKey: "useRenameEntity:failure-2",
          scope: { type: "handler", handlerId: "useRenameEntity:failure-2" },
        });
      }
      notifyRenameFailure(error, "useRenameEntity:rename");
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
        notifyRenameFailure(completed.error, "useRenameEntity:completion");
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
    mutateAsync: async (
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

/**
 * Write one field. The bare request, for a caller that settles a batch of
 * writes itself (one invalidation, one toast) instead of per write.
 */
export const upsertFieldRequest = async ({
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

  return unwrapApiResponse(response);
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

/** Move one card to a subgroup cell: its column and lane in one request. */
export const updateKanbanPlacementRequest = async ({
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

  return unwrapApiResponse(response);
};

export const useUpsertField = () => {
  const analytics = useAnalytics();
  const t = useTranslations();

  return useMutation({
    mutationFn: upsertFieldRequest,

    onError: (error) => {
      analytics.captureError(error, {
        fingerprintKey: "useUpsertField:failure",
        scope: { type: "handler", handlerId: "useUpsertField:failure" },
      });
      notifyUserError(error, t("errors.actionFailed"));
    },
  });
};
