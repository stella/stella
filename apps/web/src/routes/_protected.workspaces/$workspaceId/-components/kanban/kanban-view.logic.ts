import { panic } from "better-result";

import {
  ENTITY_KINDS,
  TASK_STATUSES as TASK_STATUS_ORDER,
} from "@stll/api-contract";
import type { EntityKind, TaskStatus } from "@stll/api-contract";
import type { OptionColor } from "@stll/api/types";

import {
  getInternalPropertyId,
  resolveKanbanGroupBy,
} from "@/components/workspaces/entity-utils";
import { resolveOptionColor } from "@/components/workspaces/property-utils";
import type { WorkspaceEntity, WorkspaceProperty } from "@/lib/types";

const STATUS_GROUP_ID = "_status";
const KIND_GROUP_ID = "_kind";
const CREATED_BY_GROUP_ID = "_created-by";

type BuiltInKanbanPropertyId =
  | typeof KIND_GROUP_ID
  | typeof CREATED_BY_GROUP_ID;

export type KanbanGrouping =
  | { type: "none" }
  | { type: "status"; propertyId: typeof STATUS_GROUP_ID }
  | { type: "built-in"; propertyId: BuiltInKanbanPropertyId }
  | {
      type: "property";
      propertyId: string;
      property: WorkspaceProperty;
    };

const isBuiltInKanbanPropertyId = (
  propertyId: string,
): propertyId is BuiltInKanbanPropertyId =>
  propertyId === KIND_GROUP_ID || propertyId === CREATED_BY_GROUP_ID;

const unreachableGrouping = (grouping: never): never => {
  panic(`Unhandled kanban grouping: ${JSON.stringify(grouping)}`);
};

export const resolveKanbanGrouping = (
  configuredGroupBy: string,
  properties: readonly WorkspaceProperty[],
): KanbanGrouping => {
  const propertyId = resolveKanbanGroupBy(configuredGroupBy, properties);

  if (propertyId === "") {
    return { type: "none" };
  }

  if (propertyId === STATUS_GROUP_ID) {
    return { type: "status", propertyId };
  }

  if (isBuiltInKanbanPropertyId(propertyId)) {
    return { type: "built-in", propertyId };
  }

  const property = properties.find((p) => p.id === propertyId);
  if (!property) {
    return { type: "none" };
  }

  return {
    type: "property",
    propertyId,
    property,
  };
};

export const getKanbanGroupingPropertyId = (
  grouping: KanbanGrouping,
): string | null => {
  switch (grouping.type) {
    case "none":
      return null;
    case "status":
    case "built-in":
    case "property":
      return grouping.propertyId;
    default:
      return unreachableGrouping(grouping);
  }
};

export const selectKanbanEntitiesForGrouping = (
  entities: readonly WorkspaceEntity[],
  grouping: KanbanGrouping,
): WorkspaceEntity[] => {
  switch (grouping.type) {
    case "none":
      return [];
    case "status":
      return entities.filter((entity) => entity.kind === "task");
    case "built-in":
    case "property":
      return [...entities];
    default:
      return unreachableGrouping(grouping);
  }
};

// -- Group enumeration (shared by kanban columns and table sections) --

export type GroupOption = {
  value: string;
  label: string;
  color?: string | undefined;
  colorBg?: string | undefined;
  optionColor?: OptionColor | undefined;
};

export type EntityGroup = {
  value: string | null;
  label: string;
  color?: string | undefined;
  colorBg?: string | undefined;
  optionColor?: OptionColor | undefined;
};

export const isGroupableProperty = (property: WorkspaceProperty): boolean =>
  property.content.type === "single-select" ||
  property.content.type === "multi-select";

const getGroupOptions = (property: WorkspaceProperty): GroupOption[] => {
  if (
    property.content.type === "single-select" ||
    property.content.type === "multi-select"
  ) {
    return property.content.options.map((opt) => ({
      value: opt.value,
      label: opt.value,
      color: resolveOptionColor(opt.color).color,
      colorBg: resolveOptionColor(opt.color).background,
      optionColor: opt.color,
    }));
  }

  return [];
};

/** All task statuses in the order they should appear as groups. */
export { TASK_STATUS_ORDER };

const STATUS_OPTION_COLORS = {
  open: "gray",
  in_progress: "blue",
  in_review: "amber",
  done: "green",
  cancelled: "red",
} as const satisfies Record<TaskStatus, OptionColor>;

/** Every status carries a label. A partial map would render a raw column
 *  heading such as "in_progress" to the user. */
export type TaskStatusLabels = Record<TaskStatus, string>;

const getStatusGroupOptions = (labels: TaskStatusLabels): GroupOption[] =>
  TASK_STATUS_ORDER.map((status) => {
    const optColor = STATUS_OPTION_COLORS[status];
    return {
      value: status,
      label: labels[status],
      color: resolveOptionColor(optColor).color,
      colorBg: resolveOptionColor(optColor).background,
      optionColor: optColor,
    };
  });

export type EntityKindLabels = Record<EntityKind, string>;

const getEntityKindGroupOptions = (labels: EntityKindLabels): GroupOption[] =>
  ENTITY_KINDS.map((kind) => ({ value: kind, label: labels[kind] }));

type BuiltInGroupOptionsParams = {
  labels: EntityKindLabels;
  mode: string;
};

const getBuiltInGroupOptions = ({
  labels,
  mode,
}: BuiltInGroupOptionsParams): GroupOption[] =>
  mode === getInternalPropertyId("kind")
    ? getEntityKindGroupOptions(labels)
    : [];

/**
 * A grouping plus exactly the labels that grouping consumes.
 *
 * The label maps used to ride along as separate fields for every call, so a
 * caller could pass an empty status map to a status board (the column
 * headings then fell back to raw values like "in_progress") and a status
 * board could be built with no labels at all. Carrying them on the arm that
 * reads them makes both unrepresentable.
 *
 * The discriminant sits at the top level rather than nested under a
 * `grouping` field because TypeScript narrows a union only by its own
 * properties: `params.grouping.type === "status"` would not narrow `params`.
 */
export type ResolveGroupOptionsParams =
  | (Extract<KanbanGrouping, { type: "status" }> & {
      statusLabels: TaskStatusLabels;
    })
  | (Extract<KanbanGrouping, { type: "built-in" }> & {
      groupByPropertyId: string;
      entityKindLabels: EntityKindLabels;
    })
  | Extract<KanbanGrouping, { type: "none" } | { type: "property" }>;

/** Resolve the static option list for a grouping (excludes uncategorized). */
export const resolveGroupOptions = (
  params: ResolveGroupOptionsParams,
): GroupOption[] => {
  switch (params.type) {
    case "status":
      return getStatusGroupOptions(params.statusLabels);
    case "built-in":
      return getBuiltInGroupOptions({
        labels: params.entityKindLabels,
        mode: params.groupByPropertyId,
      });
    case "property":
      return isGroupableProperty(params.property)
        ? getGroupOptions(params.property)
        : [];
    case "none":
      return [];
    default: {
      const exhaustive: never = params;
      return exhaustive;
    }
  }
};

/** Append the uncategorized bucket (null value) after the options. */
export const getEntityGroups = (
  options: GroupOption[],
  uncategorizedLabel: string,
): EntityGroup[] => {
  const result: EntityGroup[] = options.map((opt) => ({
    value: opt.value,
    label: opt.label,
    color: opt.color,
    colorBg: opt.colorBg,
    optionColor: opt.optionColor,
  }));
  result.push({ value: null, label: uncategorizedLabel });
  return result;
};
