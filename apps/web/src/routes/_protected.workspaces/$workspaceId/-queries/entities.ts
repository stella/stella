import { useDeferredValue } from "react";

import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { toAPIError } from "@/lib/errors";
import type { QueryOptionsInput } from "@/lib/react-query";
import { toSafeId } from "@/lib/safe-id";
import type { WorkspaceEntity, WorkspaceField } from "@/lib/types";
import {
  DEFAULT_ENTITY_VIEW_PAGE_SIZE,
  DEFAULT_ENTITY_WINDOW_SIZE,
  entitiesKeys,
  normalizeVisibleFieldIds,
  visibleEntityFieldIds,
} from "@/routes/_protected.workspaces/$workspaceId/-queries/entities.logic";
import type {
  EntitiesPageKey,
  EntitiesWindowKey,
} from "@/routes/_protected.workspaces/$workspaceId/-queries/entities.logic";

export { entitiesKeys, visibleEntityFieldIds };

type EntitiesOptionsInput = QueryOptionsInput<EntitiesPageKey>;
type EntitiesWindowOptionsInput = QueryOptionsInput<EntitiesWindowKey>;

type RawWorkspaceEntity = Omit<
  WorkspaceEntity,
  "entityId" | "parentId" | "fields"
> & {
  entityId: string;
  parentId: string | null;
  fields: {
    id: string;
    propertyId: string;
    entityId: string;
    content: WorkspaceField["content"];
  }[];
};

const toWorkspaceEntity = (entity: RawWorkspaceEntity): WorkspaceEntity => {
  const { fields: rawFields } = entity;
  const fields: Record<string, WorkspaceField> = {};
  for (const field of rawFields) {
    fields[field.propertyId] = {
      id: toSafeId<"field">(field.id),
      entityId: toSafeId<"entity">(field.entityId),
      content: field.content,
    };
  }
  return {
    entityId: toSafeId<"entity">(entity.entityId),
    kind: entity.kind,
    name: entity.name,
    parentId:
      entity.parentId === null ? null : toSafeId<"entity">(entity.parentId),
    createdAt: entity.createdAt,
    createdBy: entity.createdBy,
    createdByImage: entity.createdByImage,
    updatedAt: entity.updatedAt,
    version: entity.version,
    status: entity.status,
    priority: entity.priority,
    dueDate: entity.dueDate,
    agendaKind: entity.agendaKind,
    startAt: entity.startAt,
    endAt: entity.endAt,
    occurredAt: entity.occurredAt,
    remindAt: entity.remindAt,
    allDay: entity.allDay,
    timeZone: entity.timeZone,
    location: entity.location,
    onlineMeetingUrl: entity.onlineMeetingUrl,
    availability: entity.availability,
    sensitivity: entity.sensitivity,
    organizer: entity.organizer,
    attendees: entity.attendees,
    recurrence: entity.recurrence,
    agendaSource: entity.agendaSource,
    externalSource: entity.externalSource,
    externalId: entity.externalId,
    externalChangeKey: entity.externalChangeKey,
    externalICalUid: entity.externalICalUid,
    readOnly: entity.readOnly,
    sortOrder: entity.sortOrder,
    activeEditBy: entity.activeEditBy,
    fields,
  };
};

export const entitiesOptions = (key: EntitiesOptionsInput) =>
  queryOptions({
    queryKey: entitiesKeys.page(key),
    queryFn: async ({ signal }) => {
      const fieldMode = key.fieldMode ?? "full";
      const response = await api
        .entities({ workspaceId: toSafeId<"workspace">(key.workspaceId) })
        .query.post(
          {
            filters: key.filters,
            sorts: key.sorts,
            page: key.page,
            fieldMode,
            fieldIds:
              fieldMode === "visible"
                ? normalizeVisibleFieldIds(key.fieldIds).map((fieldId) =>
                    toSafeId<"property">(fieldId),
                  )
                : [],
            // TODO: replace this load-everything pageSize with
            // virtualised rendering + cursor pagination. Tracked
            // alongside the matching limits.ts TODO.
            pageSize: key.pageSize ?? DEFAULT_ENTITY_VIEW_PAGE_SIZE,
          },
          { fetch: { signal } },
        );

      if (response.error) {
        throw toAPIError(response.error);
      }

      const { entities: rawEntities, ...rest } = response.data;
      const entities: WorkspaceEntity[] = rawEntities.map(toWorkspaceEntity);

      return { ...rest, entities };
    },
  });

export const entitiesWindowOptions = (key: EntitiesWindowOptionsInput) =>
  infiniteQueryOptions({
    queryKey: entitiesKeys.window(key),
    queryFn: async ({ signal, pageParam }) => {
      const fieldMode = key.fieldMode ?? "full";
      const response = await api
        .entities({ workspaceId: toSafeId<"workspace">(key.workspaceId) })
        ["query-window"].post(
          {
            filters: key.filters,
            sorts: key.sorts,
            limit: key.limit ?? DEFAULT_ENTITY_WINDOW_SIZE,
            excludedKinds: key.excludedKinds ?? [],
            fieldMode,
            fieldIds:
              fieldMode === "visible"
                ? normalizeVisibleFieldIds(key.fieldIds).map((fieldId) =>
                    toSafeId<"property">(fieldId),
                  )
                : [],
            ...(pageParam !== undefined && { cursor: pageParam }),
          },
          { fetch: { signal } },
        );

      if (response.error) {
        throw toAPIError(response.error);
      }

      const { entities: rawEntities, ...rest } = response.data;
      const entities: WorkspaceEntity[] = rawEntities.map(toWorkspaceEntity);

      return { ...rest, entities };
    },
    // eslint-disable-next-line typescript/consistent-type-assertions, typescript/no-unsafe-type-assertion
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  });

// Defers the key so useSuspenseInfiniteQuery keeps showing stale
// data instead of triggering the suspense boundary when filters or
// sorts change.
export const useEntitiesWindowOptions = (key: EntitiesWindowOptionsInput) =>
  entitiesWindowOptions(useDeferredValue(key));

// Defers the key so useSuspenseQuery keeps showing stale
// data instead of triggering the suspense boundary when
// filters, sorts, or page change.
export const useEntitiesOptions = (key: EntitiesOptionsInput) =>
  entitiesOptions(useDeferredValue(key));

export const entityOptions = (workspaceId: string, entityId: string) =>
  queryOptions({
    queryKey: [...entitiesKeys.all(workspaceId), entityId],
    queryFn: async ({ signal }) => {
      const response = await api
        .entities({ workspaceId: toSafeId<"workspace">(workspaceId) })
        .entity({ entityId: toSafeId<"entity">(entityId) })
        .get({ fetch: { signal } });

      if (response.error) {
        throw toAPIError(response.error);
      }

      return response.data;
    },
  });

export const entitySummariesOptions = (workspaceId: string) =>
  queryOptions({
    queryKey: entitiesKeys.summaries(workspaceId),
    queryFn: async ({ signal }) => {
      const response = await api
        .entities({ workspaceId: toSafeId<"workspace">(workspaceId) })
        .summaries.get({ fetch: { signal } });

      if (response.error) {
        throw toAPIError(response.error);
      }

      return response.data.summaries;
    },
  });

export const entitySummariesCountOptions = (workspaceId: string) =>
  queryOptions({
    queryKey: entitiesKeys.summariesCount(workspaceId),
    queryFn: async ({ signal }) => {
      const response = await api
        .entities({ workspaceId: toSafeId<"workspace">(workspaceId) })
        .summaries.get({ fetch: { signal } });

      if (response.error) {
        throw toAPIError(response.error);
      }

      return response.data.totalCount;
    },
  });

export type WorkspaceFolder = {
  entityId: string;
  name: string;
  parentId: string | null;
};

// Returns every folder in the workspace, unpaginated. Used by features
// (e.g. the file organizer) that need a complete folder hierarchy
// regardless of which page the filesystem view is currently showing.
export const workspaceFoldersOptions = (workspaceId: string) =>
  queryOptions({
    queryKey: [...entitiesKeys.all(workspaceId), "folders"],
    queryFn: async ({ signal }): Promise<WorkspaceFolder[]> => {
      const response = await api
        .entities({ workspaceId: toSafeId<"workspace">(workspaceId) })
        .folders.get({ fetch: { signal } });

      if (response.error) {
        throw toAPIError(response.error);
      }

      return response.data.folders.map((folder) => ({
        entityId: folder.id,
        name: folder.name,
        parentId: folder.parentId,
      }));
    },
  });

export type WorkspaceFile = {
  entityId: string;
  name: string | null;
  parentId: string | null;
  fileName: string;
  mimeType: string;
};

// Returns every file-bearing entity in the workspace, unpaginated, with
// just the columns the organizer needs. Used by the file organizer so
// it operates on the whole matter rather than the FilesystemView's
// current page.
export const workspaceFilesOptions = (workspaceId: string) =>
  queryOptions({
    queryKey: [...entitiesKeys.all(workspaceId), "files"],
    queryFn: async ({ signal }): Promise<WorkspaceFile[]> => {
      const response = await api
        .entities({ workspaceId: toSafeId<"workspace">(workspaceId) })
        .files.get({ fetch: { signal } });

      if (response.error) {
        throw toAPIError(response.error);
      }

      return response.data.files.map((file) => ({
        entityId: file.entityId,
        name: file.name,
        parentId: file.parentId,
        fileName: file.fileName,
        mimeType: file.mimeType,
      }));
    },
  });
