import { useDeferredValue } from "react";

import {
  infiniteQueryOptions,
  keepPreviousData,
  queryOptions,
} from "@tanstack/react-query";

import { api } from "@/lib/api";
import { normalizeOptionalArray } from "@/lib/arrays";
import { toAPIError } from "@/lib/errors/api";
import { ROUTE_QUERY_STALE_TIME_MS } from "@/lib/react-query";
import type { QueryOptionsInput } from "@/lib/react-query";
import { toSafeId } from "@/lib/safe-id";
import type {
  WorkspaceCellMetadata,
  WorkspaceEntity,
  WorkspaceField,
} from "@/lib/types";
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
  FilesystemEntitiesKey,
  GroupCountsKey,
  KanbanGroupKey,
} from "@/routes/_protected.workspaces/$workspaceId/-queries/entities.logic";

export { DEFAULT_ENTITY_WINDOW_SIZE, entitiesKeys, visibleEntityFieldIds };

type EntitiesOptionsInput = QueryOptionsInput<EntitiesPageKey>;
type EntitiesWindowOptionsInput = QueryOptionsInput<EntitiesWindowKey>;
type FilesystemEntitiesOptionsInput = QueryOptionsInput<FilesystemEntitiesKey>;
type KanbanGroupOptionsInput = QueryOptionsInput<KanbanGroupKey>;
type GroupCountsOptionsInput = QueryOptionsInput<GroupCountsKey>;

type RawWorkspaceEntity = Omit<
  WorkspaceEntity,
  "entityId" | "parentId" | "fields" | "cellMetadata"
> & {
  entityId: string;
  parentId: string | null;
  fields: {
    id: string;
    propertyId: string;
    entityId: string;
    content: WorkspaceField["content"];
  }[];
  cellMetadata: {
    propertyId: string;
    metadata: WorkspaceCellMetadata;
  }[];
};

const toWorkspaceEntity = (entity: RawWorkspaceEntity): WorkspaceEntity => {
  const { fields: rawFields } = entity;
  const fields: WorkspaceEntity["fields"] = {};
  for (const field of rawFields) {
    const propertyId = toSafeId<"property">(field.propertyId);
    fields[propertyId] = {
      id: toSafeId<"field">(field.id),
      entityId: toSafeId<"entity">(field.entityId),
      propertyId,
      content: field.content,
    };
  }
  const cellMetadata: WorkspaceEntity["cellMetadata"] = {};
  for (const entry of entity.cellMetadata) {
    cellMetadata[toSafeId<"property">(entry.propertyId)] = entry.metadata;
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
    createdByDeletedAt: entity.createdByDeletedAt,
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
    cellMetadata,
  };
};

export const entitiesOptions = (key: EntitiesOptionsInput) =>
  queryOptions({
    queryKey: entitiesKeys.sample(key),
    queryFn: async ({ signal }) => {
      const fieldMode = key.fieldMode ?? "full";
      const response = await api
        .entities({ workspaceId: toSafeId<"workspace">(key.workspaceId) })
        ["query-window"].post(
          {
            filters: key.filters,
            sorts: key.sorts,
            ...(key.search?.trim() && { search: key.search.trim() }),
            excludedKinds: normalizeOptionalArray(key.excludedKinds),
            fieldMode,
            fieldIds:
              fieldMode === "visible"
                ? normalizeVisibleFieldIds(key.fieldIds).map((fieldId) =>
                    toSafeId<"property">(fieldId),
                  )
                : [],
            previewableForAi: key.previewableForAi ?? false,
            limit: key.pageSize ?? DEFAULT_ENTITY_VIEW_PAGE_SIZE,
          },
          { fetch: { signal } },
        );

      if (response.error) {
        throw toAPIError(response.error);
      }

      const { items: rawEntities, ...rest } = response.data;
      const entities: WorkspaceEntity[] = rawEntities.map(toWorkspaceEntity);

      return { ...rest, entities };
    },
  });

export const entitiesWindowOptions = (key: EntitiesWindowOptionsInput) => {
  // Widen the page-param type so TanStack infers TPageParam as the cursor's
  // `string | undefined` (from `undefined` alone it collapses to the literal
  // `undefined`, which then clashes with the queryFn/getNextPageParam cursor).
  const initialPageParam: string | undefined = undefined;
  return infiniteQueryOptions({
    queryKey: entitiesKeys.window(key),
    queryFn: async ({ signal, pageParam }) => {
      const fieldMode = key.fieldMode ?? "full";
      const response = await api
        .entities({ workspaceId: toSafeId<"workspace">(key.workspaceId) })
        ["query-window"].post(
          {
            filters: key.filters,
            sorts: key.sorts,
            ...(key.search?.trim() && { search: key.search.trim() }),
            limit: key.limit ?? DEFAULT_ENTITY_WINDOW_SIZE,
            excludedKinds: normalizeOptionalArray(key.excludedKinds),
            fieldMode,
            fieldIds:
              fieldMode === "visible"
                ? normalizeVisibleFieldIds(key.fieldIds).map((fieldId) =>
                    toSafeId<"property">(fieldId),
                  )
                : [],
            previewableForAi: key.previewableForAi ?? false,
            ...(pageParam !== undefined && { cursor: pageParam }),
          },
          { fetch: { signal } },
        );

      if (response.error) {
        throw toAPIError(response.error);
      }

      const { items: rawEntities, ...rest } = response.data;
      const entities: WorkspaceEntity[] = rawEntities.map(toWorkspaceEntity);

      return { ...rest, entities };
    },
    initialPageParam,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    staleTime: ROUTE_QUERY_STALE_TIME_MS,
  });
};

export const filesystemEntitiesOptions = (
  key: FilesystemEntitiesOptionsInput,
) =>
  queryOptions({
    queryKey: entitiesKeys.filesystemTree(key),
    queryFn: async ({ signal }) => {
      const fieldMode = key.fieldMode ?? "full";
      const response = await api
        .entities({ workspaceId: toSafeId<"workspace">(key.workspaceId) })
        ["filesystem-tree"].post(
          {
            filters: key.filters,
            sorts: key.sorts,
            ...(key.search?.trim() && { search: key.search.trim() }),
            fieldMode,
            fieldIds:
              fieldMode === "visible"
                ? normalizeVisibleFieldIds(key.fieldIds).map((fieldId) =>
                    toSafeId<"property">(fieldId),
                  )
                : [],
          },
          { fetch: { signal } },
        );

      if (response.error) {
        throw toAPIError(response.error);
      }

      const entities: WorkspaceEntity[] =
        response.data.entities.map(toWorkspaceEntity);

      // Parent links of ancestor folders a filter/search hid. Used only to
      // complete the ancestor chain for cross-matter copy/move dedup; never
      // rendered, so they stay out of selection and bulk actions.
      const ancestorLinks = response.data.ancestorLinks;

      return { entities, ancestorLinks };
    },
    staleTime: ROUTE_QUERY_STALE_TIME_MS,
  });

export const kanbanGroupOptions = (key: KanbanGroupOptionsInput) => {
  const initialPageParam: string | undefined = undefined;
  return infiniteQueryOptions({
    queryKey: entitiesKeys.kanbanGroup(key),
    queryFn: async ({ signal, pageParam }) => {
      const fieldMode = key.fieldMode ?? "full";
      const response = await api
        .entities({ workspaceId: toSafeId<"workspace">(key.workspaceId) })
        ["kanban-group"].post(
          {
            filters: key.filters,
            sorts: key.sorts,
            limit: key.limit ?? DEFAULT_ENTITY_WINDOW_SIZE,
            fieldMode,
            fieldIds:
              fieldMode === "visible"
                ? normalizeVisibleFieldIds(key.fieldIds).map((fieldId) =>
                    toSafeId<"property">(fieldId),
                  )
                : [],
            groupByPropertyId:
              key.groupByPropertyId === "_status" ||
              key.groupByPropertyId === "_kind"
                ? key.groupByPropertyId
                : toSafeId<"property">(key.groupByPropertyId),
            groupValue: key.groupValue,
            excludedKinds: normalizeOptionalArray(key.excludedKinds),
            ...(key.optionValues !== undefined && {
              optionValues: key.optionValues,
            }),
            ...(pageParam !== undefined && { cursor: pageParam }),
          },
          { fetch: { signal } },
        );

      if (response.error) {
        throw toAPIError(response.error);
      }

      const { items: rawEntities, ...rest } = response.data;
      const entities: WorkspaceEntity[] = rawEntities.map(toWorkspaceEntity);

      return { ...rest, entities };
    },
    initialPageParam,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    // The key carries the visible fieldIds, so showing/hiding a column changes
    // it and refetches. Keep the previous rows on screen during that refetch
    // (and on filter/sort/paging changes) instead of dropping every group to
    // skeleton — the rows already exist, only the column set changed.
    placeholderData: keepPreviousData,
  });
};

// Per-group entity counts in one query, so the grouped table can skip
// firing a row query for empty groups.
export const groupCountsOptions = (key: GroupCountsOptionsInput) =>
  queryOptions({
    queryKey: entitiesKeys.groupCounts(key),
    queryFn: async ({ signal }) => {
      const response = await api
        .entities({ workspaceId: toSafeId<"workspace">(key.workspaceId) })
        ["group-counts"].post(
          {
            filters: key.filters,
            groupByPropertyId:
              key.groupByPropertyId === "_status" ||
              key.groupByPropertyId === "_kind"
                ? key.groupByPropertyId
                : toSafeId<"property">(key.groupByPropertyId),
          },
          { fetch: { signal } },
        );

      if (response.error) {
        throw toAPIError(response.error);
      }

      return response.data.counts;
    },
  });

// Defers the key so useSuspenseInfiniteQuery keeps showing stale
// data instead of triggering the suspense boundary when filters or
// sorts change.
export const useEntitiesWindowOptions = (key: EntitiesWindowOptionsInput) =>
  entitiesWindowOptions(useDeferredValue(key));

export const useKanbanGroupOptions = (key: KanbanGroupOptionsInput) =>
  kanbanGroupOptions(useDeferredValue(key));

// Defers the key so useSuspenseQuery keeps showing stale
// data instead of triggering the suspense boundary when
// filters, sorts, or page change.
export const useEntitiesOptions = (key: EntitiesOptionsInput) =>
  entitiesOptions(useDeferredValue(key));

export const entityOptions = (workspaceId: string, entityId: string) =>
  queryOptions({
    queryKey: [...entitiesKeys.all(workspaceId), entityId],
    staleTime: ROUTE_QUERY_STALE_TIME_MS,
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
      const summaries: { id: string; name: string | null }[] = [];
      let cursor: string | undefined;
      do {
        // oxlint-disable-next-line no-await-in-loop -- cursor pagination: each page depends on the previous response's nextCursor, so requests are strictly sequential
        const response = await api
          .entities({ workspaceId: toSafeId<"workspace">(workspaceId) })
          .summaries.get({
            fetch: { signal },
            query: {
              limit: DEFAULT_ENTITY_WINDOW_SIZE,
              ...(cursor !== undefined && { cursor }),
            },
          });

        if (response.error) {
          throw toAPIError(response.error);
        }

        summaries.push(
          ...response.data.items.map(({ id, name }) => ({ id, name })),
        );
        cursor = response.data.nextCursor ?? undefined;
      } while (cursor !== undefined);

      return summaries;
    },
  });

export const entitySummariesCountOptions = (workspaceId: string) =>
  queryOptions({
    queryKey: entitiesKeys.summariesCount(workspaceId),
    queryFn: async ({ signal }) => {
      const response = await api
        .entities({ workspaceId: toSafeId<"workspace">(workspaceId) })
        .summaries.count.get({ fetch: { signal }, query: {} });

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

const fetchAllWorkspaceFolders = async ({
  signal,
  workspaceId,
}: {
  signal: AbortSignal;
  workspaceId: string;
}): Promise<WorkspaceFolder[]> => {
  const folders: WorkspaceFolder[] = [];
  let cursor: string | undefined;
  do {
    // oxlint-disable-next-line no-await-in-loop -- cursor pagination: each page depends on the previous response's nextCursor, so requests are strictly sequential
    const response = await api
      .entities({ workspaceId: toSafeId<"workspace">(workspaceId) })
      .folders.get({
        fetch: { signal },
        query: {
          limit: DEFAULT_ENTITY_WINDOW_SIZE,
          ...(cursor !== undefined && { cursor }),
        },
      });

    if (response.error) {
      throw toAPIError(response.error);
    }

    folders.push(
      ...response.data.items.map((folder) => ({
        entityId: folder.id,
        name: folder.name,
        parentId: folder.parentId,
      })),
    );
    cursor = response.data.nextCursor ?? undefined;
  } while (cursor !== undefined);

  return folders;
};

// Fetches the complete folder hierarchy in bounded pages. The API
// response is paginated so large matters never return one giant
// organizer payload.
export const workspaceFoldersOptions = (workspaceId: string) =>
  queryOptions({
    queryKey: [...entitiesKeys.all(workspaceId), "folders"],
    queryFn: async ({ signal }) =>
      await fetchAllWorkspaceFolders({ signal, workspaceId }),
  });

export type WorkspaceFile = {
  entityId: string;
  name: string | null;
  parentId: string | null;
  fileName: string;
  mimeType: string;
};

const fetchAllWorkspaceFiles = async ({
  signal,
  workspaceId,
}: {
  signal: AbortSignal;
  workspaceId: string;
}): Promise<WorkspaceFile[]> => {
  const files: WorkspaceFile[] = [];
  let cursor: string | undefined;
  do {
    // oxlint-disable-next-line no-await-in-loop -- cursor pagination: each page depends on the previous response's nextCursor, so requests are strictly sequential
    const response = await api
      .entities({ workspaceId: toSafeId<"workspace">(workspaceId) })
      .files.get({
        fetch: { signal },
        query: {
          limit: DEFAULT_ENTITY_WINDOW_SIZE,
          ...(cursor !== undefined && { cursor }),
        },
      });

    if (response.error) {
      throw toAPIError(response.error);
    }

    files.push(
      ...response.data.items.map((file) => ({
        entityId: file.entityId,
        name: file.name,
        parentId: file.parentId,
        fileName: file.fileName,
        mimeType: file.mimeType,
      })),
    );
    cursor = response.data.nextCursor ?? undefined;
  } while (cursor !== undefined);

  return files;
};

// Fetches every file-bearing entity in bounded pages, with just the
// columns the organizer needs. The organizer still operates across the
// whole matter, but no single request returns the whole file set.
export const workspaceFilesOptions = (workspaceId: string) =>
  queryOptions({
    queryKey: [...entitiesKeys.all(workspaceId), "files"],
    queryFn: async ({ signal }) =>
      await fetchAllWorkspaceFiles({ signal, workspaceId }),
  });
