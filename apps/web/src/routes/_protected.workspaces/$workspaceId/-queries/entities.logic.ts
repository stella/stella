import type {
  EntityKind,
  ViewFilterCondition,
  WorkspaceProperty,
} from "@/lib/types";

export type ViewSort = {
  propertyId: string;
  desc: boolean;
};

export type EntitiesFieldMode = "full" | "visible";

export type EntitiesPageKey = {
  workspaceId: string;
  filters: ViewFilterCondition[];
  sorts: ViewSort[];
  page: number;
  search?: string;
  pageSize?: number;
  fieldMode?: EntitiesFieldMode;
  fieldIds?: string[];
  excludedKinds?: EntityKind[];
  previewableForAi?: boolean;
};

export type EntitiesWindowKey = Omit<EntitiesPageKey, "page" | "pageSize"> & {
  limit?: number;
};

export type KanbanGroupKey = Omit<EntitiesWindowKey, "excludedKinds"> & {
  groupByPropertyId: string;
  groupValue: string | null;
};

export const DEFAULT_ENTITY_VIEW_PAGE_SIZE = 100;
export const DEFAULT_ENTITY_WINDOW_SIZE = 200;

export const normalizeVisibleFieldIds = (
  fieldIds: string[] | undefined,
): string[] =>
  fieldIds === undefined ? [] : [...new Set(fieldIds)].toSorted();

export const entitiesKeys = {
  all: (workspaceId: string) => ["entities", workspaceId],
  page: ({
    workspaceId,
    filters,
    sorts,
    page,
    search,
    pageSize,
    fieldMode,
    fieldIds,
    excludedKinds,
    previewableForAi,
  }: EntitiesPageKey) => {
    const normalizedFieldMode = fieldMode ?? "full";
    return [
      ...entitiesKeys.all(workspaceId),
      {
        filters,
        sorts,
        page,
        ...(search?.trim() && { search: search.trim() }),
        pageSize: pageSize ?? DEFAULT_ENTITY_VIEW_PAGE_SIZE,
        fieldMode: normalizedFieldMode,
        fieldIds:
          normalizedFieldMode === "visible"
            ? normalizeVisibleFieldIds(fieldIds)
            : [],
        excludedKinds: excludedKinds?.toSorted() ?? [],
        previewableForAi: previewableForAi ?? false,
      },
    ];
  },
  window: ({
    workspaceId,
    filters,
    sorts,
    search,
    limit,
    fieldMode,
    fieldIds,
    excludedKinds,
    previewableForAi,
  }: EntitiesWindowKey) => {
    const normalizedFieldMode = fieldMode ?? "full";
    return [
      ...entitiesKeys.all(workspaceId),
      "window",
      {
        filters,
        sorts,
        ...(search?.trim() && { search: search.trim() }),
        limit: limit ?? DEFAULT_ENTITY_WINDOW_SIZE,
        fieldMode: normalizedFieldMode,
        fieldIds:
          normalizedFieldMode === "visible"
            ? normalizeVisibleFieldIds(fieldIds)
            : [],
        excludedKinds: excludedKinds?.toSorted() ?? [],
        previewableForAi: previewableForAi ?? false,
      },
    ];
  },
  kanbanGroup: ({
    workspaceId,
    filters,
    sorts,
    limit,
    fieldMode,
    fieldIds,
    groupByPropertyId,
    groupValue,
  }: KanbanGroupKey) => {
    const normalizedFieldMode = fieldMode ?? "full";
    return [
      ...entitiesKeys.all(workspaceId),
      "kanban-group",
      {
        filters,
        sorts,
        limit: limit ?? DEFAULT_ENTITY_WINDOW_SIZE,
        fieldMode: normalizedFieldMode,
        fieldIds:
          normalizedFieldMode === "visible"
            ? normalizeVisibleFieldIds(fieldIds)
            : [],
        groupByPropertyId,
        groupValue,
      },
    ];
  },
  summaries: (workspaceId: string) => [
    ...entitiesKeys.all(workspaceId),
    "summaries",
  ],
  summariesCount: (workspaceId: string) => [
    ...entitiesKeys.summaries(workspaceId),
    "count",
  ],
};

export const visibleEntityFieldIds = ({
  hiddenProperties,
  properties,
  requiredPropertyIds = [],
}: {
  hiddenProperties: readonly string[];
  properties: readonly WorkspaceProperty[];
  requiredPropertyIds?: readonly string[];
}): string[] => {
  const propertyIds = new Set<string>();
  for (const property of properties) {
    if (property.content.type === "file") {
      propertyIds.add(property.id);
      continue;
    }

    if (!hiddenProperties.includes(property.id)) {
      propertyIds.add(property.id);
    }
  }

  const allowedRequiredIds = new Set(properties.map((property) => property.id));
  for (const propertyId of requiredPropertyIds) {
    if (allowedRequiredIds.has(propertyId)) {
      propertyIds.add(propertyId);
    }
  }
  return [...propertyIds].toSorted();
};
