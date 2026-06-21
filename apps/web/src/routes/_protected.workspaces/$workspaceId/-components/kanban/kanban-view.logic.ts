import { panic } from "better-result";

import type { OptionColor } from "@stll/api/types";

import type { WorkspaceEntity, WorkspaceProperty } from "@/lib/types";
import { resolveOptionColor } from "@/routes/_protected.workspaces/$workspaceId/-components/utils";
import {
  getInternalPropertyId,
  resolveKanbanGroupBy,
} from "@/routes/_protected.workspaces/$workspaceId/-utils";

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
export const TASK_STATUS_ORDER = [
  "open",
  "in_progress",
  "in_review",
  "done",
  "cancelled",
] as const;

const STATUS_OPTION_COLORS: Record<string, OptionColor> = {
  // eslint-disable-next-line no-inline-style-colors/no-inline-style-colors -- OptionColor domain constant, not a CSS color value
  open: "gray",
  // eslint-disable-next-line no-inline-style-colors/no-inline-style-colors -- OptionColor domain constant, not a CSS color value
  in_progress: "blue",
  in_review: "amber",
  // eslint-disable-next-line no-inline-style-colors/no-inline-style-colors -- OptionColor domain constant, not a CSS color value
  done: "green",
  // eslint-disable-next-line no-inline-style-colors/no-inline-style-colors -- OptionColor domain constant, not a CSS color value
  cancelled: "red",
};

const getStatusGroupOptions = (labels: Record<string, string>): GroupOption[] =>
  TASK_STATUS_ORDER.map((status) => {
    const optColor = STATUS_OPTION_COLORS[status] ?? "gray";
    return {
      value: status,
      label: labels[status] ?? status,
      color: resolveOptionColor(optColor).color,
      colorBg: resolveOptionColor(optColor).background,
      optionColor: optColor,
    };
  });

export type EntityKindLabels = Record<
  "document" | "folder" | "task" | "message" | "link",
  string
>;

const getEntityKindGroupOptions = (labels: EntityKindLabels): GroupOption[] => [
  { value: "document", label: labels.document },
  { value: "folder", label: labels.folder },
  { value: "task", label: labels.task },
  { value: "message", label: labels.message },
  { value: "link", label: labels.link },
];

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

type ResolveGroupOptionsParams = {
  grouping: KanbanGrouping;
  groupByPropertyId: string;
  statusLabels: Record<string, string>;
  entityKindLabels: EntityKindLabels;
};

/** Resolve the static option list for a grouping (excludes uncategorized). */
export const resolveGroupOptions = ({
  grouping,
  groupByPropertyId,
  statusLabels,
  entityKindLabels,
}: ResolveGroupOptionsParams): GroupOption[] => {
  if (grouping.type === "status") {
    return getStatusGroupOptions(statusLabels);
  }
  if (grouping.type === "built-in") {
    return getBuiltInGroupOptions({
      labels: entityKindLabels,
      mode: groupByPropertyId,
    });
  }
  if (grouping.type === "property" && isGroupableProperty(grouping.property)) {
    return getGroupOptions(grouping.property);
  }
  return [];
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
