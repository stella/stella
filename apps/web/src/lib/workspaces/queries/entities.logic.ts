import { hashKey } from "@tanstack/react-query";

import type { EntityFind } from "@stll/api-contract";

import type { ConditionNode, EntityKind, WorkspaceProperty } from "@/lib/types";

/**
 * A find, as it travels to the server. `find.term` is the find bar's submitted
 * term: what is typed never reaches a key, or every keystroke would mint a
 * cache entry.
 *
 * Separate from `search`: that one ranks an asynchronous index for the mention
 * picker, this one filters the rows the grid renders. The scope's property list
 * is always explicit, because group-counts takes no field selection and so
 * cannot derive a default that would agree with the rows.
 */
export type EntitiesFindKey = {
  find?: EntityFind | undefined;
};

/**
 * A blank term drops the whole find, so an open-but-empty find bar costs
 * neither a cache entry nor a server condition. Property ids sort, so the same
 * selection reached two ways is one cache key.
 */
export const normalizeFind = (
  find: EntityFind | undefined,
): EntityFind | null => {
  const term = find?.term.trim();
  if (!find || !term) {
    return null;
  }
  return {
    scope: {
      propertyIds: [...find.scope.propertyIds].toSorted(),
      type: find.scope.type,
    },
    term,
  };
};

export type ViewSort = {
  propertyId: string;
  desc: boolean;
};

export type EntitiesFieldMode = "full" | "visible";

export type EntitiesPageKey = {
  workspaceId: string;
  filters: ConditionNode[];
  sorts: ViewSort[];
  search?: string;
  pageSize?: number;
  fieldMode?: EntitiesFieldMode;
  fieldIds?: string[];
  excludedKinds?: EntityKind[];
  previewableForAi?: boolean;
};

export type EntitiesWindowKey = Omit<EntitiesPageKey, "page" | "pageSize"> &
  EntitiesFindKey & {
    limit?: number;
    // Off by default: the assignees join is extra work every other window
    // caller skips. Only the kanban assignee sub-group's window request
    // sets this.
    includeAssignees?: boolean;
  };

export type FilesystemEntitiesKey = Omit<
  EntitiesPageKey,
  "page" | "pageSize" | "excludedKinds" | "previewableForAi"
>;

export type KanbanGroupKey = EntitiesWindowKey & {
  groupByPropertyId: string;
  groupValue: string | null;
  // The property's option values. Sent by the grouped table so the uncategorized
  // group folds in stale (out-of-options) cells; omitted by the kanban board.
  optionValues?: string[];
};

export type GroupCountsKey = EntitiesFindKey & {
  workspaceId: string;
  filters: ConditionNode[];
  groupByPropertyId: string;
  // The grouping property's option values. The counts depend on them (option
  // buckets + the uncategorized fold), so a rename/delete of an option must
  // invalidate the cache.
  optionValues?: string[];
};

export const DEFAULT_ENTITY_VIEW_PAGE_SIZE = 100;
export const DEFAULT_ENTITY_WINDOW_SIZE = 200;

export const normalizeVisibleFieldIds = (
  fieldIds: string[] | undefined,
): string[] =>
  fieldIds === undefined ? [] : [...new Set(fieldIds)].toSorted();

export const entitiesKeys = {
  all: (workspaceId: string) => ["entities", workspaceId],
  detail: (workspaceId: string, entityId: string) => [
    ...entitiesKeys.all(workspaceId),
    entityId,
  ],
  versions: (workspaceId: string, entityId: string) => [
    ...entitiesKeys.detail(workspaceId, entityId),
    "versions",
  ],
  sample: ({
    workspaceId,
    filters,
    sorts,
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
        ...(search?.trim() && { search: search.trim() }),
        pageSize: pageSize ?? DEFAULT_ENTITY_VIEW_PAGE_SIZE,
        fieldMode: normalizedFieldMode,
        fieldIds:
          normalizedFieldMode === "visible"
            ? normalizeVisibleFieldIds(fieldIds)
            : [],
        excludedKinds: excludedKinds ? excludedKinds.toSorted() : [],
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
    includeAssignees,
    find,
  }: EntitiesWindowKey) => {
    const normalizedFieldMode = fieldMode ?? "full";
    const normalizedFind = normalizeFind(find);
    return [
      ...entitiesKeys.all(workspaceId),
      "window",
      {
        filters,
        sorts,
        ...(search?.trim() && { search: search.trim() }),
        ...(normalizedFind && { find: normalizedFind }),
        limit: limit ?? DEFAULT_ENTITY_WINDOW_SIZE,
        fieldMode: normalizedFieldMode,
        fieldIds:
          normalizedFieldMode === "visible"
            ? normalizeVisibleFieldIds(fieldIds)
            : [],
        excludedKinds: excludedKinds ? excludedKinds.toSorted() : [],
        previewableForAi: previewableForAi ?? false,
        includeAssignees: includeAssignees ?? false,
      },
    ];
  },
  filesystemTree: ({
    workspaceId,
    filters,
    sorts,
    search,
    fieldMode,
    fieldIds,
  }: FilesystemEntitiesKey) => {
    const normalizedFieldMode = fieldMode ?? "full";
    return [
      ...entitiesKeys.all(workspaceId),
      "filesystem-tree",
      {
        filters,
        sorts,
        ...(search?.trim() && { search: search.trim() }),
        fieldMode: normalizedFieldMode,
        fieldIds:
          normalizedFieldMode === "visible"
            ? normalizeVisibleFieldIds(fieldIds)
            : [],
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
    excludedKinds,
    groupByPropertyId,
    groupValue,
    optionValues,
    find,
  }: KanbanGroupKey) => {
    const normalizedFieldMode = fieldMode ?? "full";
    const normalizedFind = normalizeFind(find);
    return [
      ...entitiesKeys.all(workspaceId),
      "kanban-group",
      {
        filters,
        sorts,
        ...(normalizedFind && { find: normalizedFind }),
        limit: limit ?? DEFAULT_ENTITY_WINDOW_SIZE,
        fieldMode: normalizedFieldMode,
        fieldIds:
          normalizedFieldMode === "visible"
            ? normalizeVisibleFieldIds(fieldIds)
            : [],
        excludedKinds: excludedKinds ? excludedKinds.toSorted() : [],
        groupByPropertyId,
        groupValue,
        optionValues: optionValues?.toSorted(),
      },
    ];
  },
  groupCounts: ({
    workspaceId,
    filters,
    groupByPropertyId,
    optionValues,
    find,
  }: GroupCountsKey) => {
    const normalizedFind = normalizeFind(find);
    return [
      ...entitiesKeys.all(workspaceId),
      "group-counts",
      {
        filters,
        groupByPropertyId,
        optionValues: optionValues?.toSorted(),
        ...(normalizedFind && { find: normalizedFind }),
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

/** The shape every kanban-group key ends in; any object may be read as it. */
const isKeyParams = (
  value: unknown,
): value is {
  find?: unknown;
  groupByPropertyId?: unknown;
  groupValue?: unknown;
} => typeof value === "object" && value !== null;

/**
 * What a kanban-group key says about which rows it holds, as opposed to how
 * many of them and which of their cells: the workspace, the group, and the
 * find. Null for a key that is not a kanban-group key at all.
 */
const kanbanRowsIdentity = (queryKey: readonly unknown[]): string | null => {
  const [root, workspaceId, kind, params] = queryKey;
  if (root !== "entities" || kind !== "kanban-group" || !isKeyParams(params)) {
    return null;
  }
  return hashKey([
    workspaceId,
    params.groupByPropertyId,
    params.groupValue,
    params.find,
  ]);
};

/**
 * Whether a group's previous rows may stand in for `key`'s while they load.
 *
 * They may while columns, filters, sorts or paging change: the rows already
 * exist, and dropping every group to skeleton for a column toggle is the
 * flicker `placeholderData` is there to prevent. They may not across a find.
 * The group counts answer first and carry the new term, and the marks over
 * the rows already name it, so the previous term's rows would render under
 * the new term's counts and highlights until their replacement arrived. Rows
 * of another workspace or another group are not these rows either.
 */
export const keepsRowsAcrossFind = (
  previousKey: readonly unknown[] | undefined,
  key: KanbanGroupKey,
): boolean =>
  previousKey !== undefined &&
  kanbanRowsIdentity(previousKey) !== null &&
  kanbanRowsIdentity(previousKey) ===
    kanbanRowsIdentity(entitiesKeys.kanbanGroup(key));

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
  const hiddenPropertyIds = new Set(hiddenProperties);
  for (const property of properties) {
    if (property.content.type === "file") {
      propertyIds.add(property.id);
      continue;
    }

    if (!hiddenPropertyIds.has(property.id)) {
      propertyIds.add(property.id);
    }
  }

  const allowedRequiredIds = new Set<string>(
    properties.map((property) => property.id),
  );
  for (const propertyId of requiredPropertyIds) {
    if (allowedRequiredIds.has(propertyId)) {
      propertyIds.add(propertyId);
    }
  }
  return [...propertyIds].toSorted();
};
