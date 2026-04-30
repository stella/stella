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
  pageSize?: number;
  fieldMode?: EntitiesFieldMode;
  fieldIds?: string[];
};

export type EntitiesWindowKey = Omit<EntitiesPageKey, "page" | "pageSize"> & {
  limit?: number;
  excludedKinds?: EntityKind[];
};

export const DEFAULT_ENTITY_VIEW_PAGE_SIZE = 10_000;
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
    pageSize,
    fieldMode,
    fieldIds,
  }: EntitiesPageKey) => {
    const normalizedFieldMode = fieldMode ?? "full";
    return [
      ...entitiesKeys.all(workspaceId),
      {
        filters,
        sorts,
        page,
        pageSize: pageSize ?? DEFAULT_ENTITY_VIEW_PAGE_SIZE,
        fieldMode: normalizedFieldMode,
        fieldIds:
          normalizedFieldMode === "visible"
            ? normalizeVisibleFieldIds(fieldIds)
            : [],
      },
    ];
  },
  window: ({
    workspaceId,
    filters,
    sorts,
    limit,
    fieldMode,
    fieldIds,
    excludedKinds,
  }: EntitiesWindowKey) => {
    const normalizedFieldMode = fieldMode ?? "full";
    return [
      ...entitiesKeys.all(workspaceId),
      "window",
      {
        filters,
        sorts,
        limit: limit ?? DEFAULT_ENTITY_WINDOW_SIZE,
        fieldMode: normalizedFieldMode,
        fieldIds:
          normalizedFieldMode === "visible"
            ? normalizeVisibleFieldIds(fieldIds)
            : [],
        excludedKinds: excludedKinds?.toSorted() ?? [],
      },
    ];
  },
  summaries: (workspaceId: string) => [
    ...entitiesKeys.all(workspaceId),
    "summaries",
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
