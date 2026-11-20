/**
 * How a workspace board's columns are made, apart from the rest of the board:
 * the built-in groupings (task status, entity kind, created by, assignee),
 * the options a select property groups by, and the view's group-by resolved
 * against the matter's properties. A loading view lays out a board's columns
 * from the same functions the board resolves them with, without loading the
 * board.
 */

import { Result } from "better-result";

import {
  ENTITY_KINDS,
  TASK_STATUSES as TASK_STATUS_ORDER,
} from "@stll/api-contract";
import type { EntityKind, TaskStatus } from "@stll/api-contract";
import { Temporal } from "@stll/time";
import { resolveKanbanGrouping } from "@stll/ui/kanban-grouping";
import type {
  KanbanBuiltInGroup,
  KanbanGrouping,
  KanbanGroupOption,
  KanbanSchema,
} from "@stll/ui/kanban-grouping";

import { getInternalPropertyId } from "@/components/workspaces/internal-ids.logic";
import { resolveOptionColor } from "@/components/workspaces/property-utils";
import { TASK_STATUS_OPTION_COLORS } from "@/components/workspaces/tasks/task-detail-constants";
import type { PropertyOptionColor } from "@/lib/api-contract";
import type { WorkspaceEntity, WorkspaceProperty } from "@/lib/types";

const instantEpoch = (value: string): number =>
  Result.try(() => Temporal.Instant.from(value).epochMilliseconds).unwrapOr(0);

export type WorkspaceKanbanSchema = KanbanSchema<
  WorkspaceEntity,
  WorkspaceProperty
>;

export type WorkspaceKanbanGrouping = KanbanGrouping<
  WorkspaceEntity,
  WorkspaceProperty
>;

/** All task statuses in the order they should appear as groups. */

/** Every status carries a label. A partial map would render a raw column
 *  heading such as "in_progress" to the user. */
type TaskStatusLabels = Record<TaskStatus, string>;

type EntityKindLabels = Record<EntityKind, string>;

const toGroupOption = (
  value: string,
  label: string,
  color: PropertyOptionColor,
) => {
  const variants = resolveOptionColor(color);
  return {
    value,
    label,
    color: variants.color,
    colorBg: variants.background,
    optionColor: color,
  };
};

/** Only a task carries a status, so a status board is a board of tasks. */
const statusGroup = (
  labels: TaskStatusLabels,
): KanbanBuiltInGroup<WorkspaceEntity> => ({
  id: getInternalPropertyId("status"),
  options: TASK_STATUS_ORDER.map((status) =>
    toGroupOption(status, labels[status], TASK_STATUS_OPTION_COLORS[status]),
  ),
  selectRows: (rows) => rows.filter((row) => row.kind === "task"),
});

const kindGroup = (
  labels: EntityKindLabels,
): KanbanBuiltInGroup<WorkspaceEntity> => ({
  id: getInternalPropertyId("kind"),
  options: ENTITY_KINDS.map((kind) => ({ value: kind, label: labels[kind] })),
});

/**
 * Created-by is offered as a group-by but has no column list to offer: the
 * authors are whoever happens to be in the workspace, not a fixed set. An empty
 * option list is what tells the board it cannot be drawn.
 */
const createdByGroup = (): KanbanBuiltInGroup<WorkspaceEntity> => ({
  id: getInternalPropertyId("created-by"),
  options: [],
});

/**
 * Assignee is a sub-group-only lane: the primary Group picker never offers
 * it (server paging and counts do not support grouping by it), but it shares
 * the created-by mechanism of declaring no fixed column list, since who is
 * assigned is data on the loaded rows rather than a fixed set.
 */
const assigneeGroup = (): KanbanBuiltInGroup<WorkspaceEntity> => ({
  id: getInternalPropertyId("assignee"),
  options: [],
});

export const isGroupableProperty = (property: WorkspaceProperty): boolean =>
  property.content.type === "single-select" ||
  property.content.type === "multi-select";

export const isKanbanSubgroupProperty = (
  property: WorkspaceProperty,
): boolean =>
  property.content.type === "single-select" ||
  property.content.type === "person";

const getPropertyOptions = (
  property: WorkspaceProperty,
): KanbanGroupOption[] | null => {
  if (
    property.content.type !== "single-select" &&
    property.content.type !== "multi-select"
  ) {
    return null;
  }

  return property.content.options.map((option) =>
    toGroupOption(option.value, option.value, option.color),
  );
};

type WorkspaceKanbanSchemaParams = {
  properties: readonly WorkspaceProperty[];
  statusLabels: TaskStatusLabels;
  entityKindLabels: EntityKindLabels;
};

/**
 * The label maps ride on the schema rather than on each call, so a status board
 * cannot be built without a complete set of status labels.
 */
export const workspaceKanbanSchema = ({
  properties,
  statusLabels,
  entityKindLabels,
}: WorkspaceKanbanSchemaParams): WorkspaceKanbanSchema => ({
  builtInGroups: [
    statusGroup(statusLabels),
    kindGroup(entityKindLabels),
    createdByGroup(),
    assigneeGroup(),
  ],
  properties,
  getPropertyId: (property) => property.id,
  getPropertyOptions,
});

/**
 * Resolve a view's stored group-by, falling back to the workspace's default
 * when the view carries none.
 */
export const resolveWorkspaceKanbanGrouping = (
  configuredGroupBy: string,
  schema: WorkspaceKanbanSchema,
): WorkspaceKanbanGrouping =>
  resolveKanbanGrouping({
    groupBy: resolveKanbanGroupBy(configuredGroupBy, schema.properties),
    schema,
  });

/**
 * Resolve the group-by property ID for kanban views.
 *
 * Fallback order when no explicit config is set:
 * 1. A single-select property named "Status" (case-insensitive)
 * 2. The most recently created single-select manual-input property
 */
export const resolveKanbanGroupBy = (
  configuredId: string,
  properties: readonly WorkspaceProperty[],
): string => {
  if (configuredId) {
    return configuredId;
  }

  const eligible = properties.filter((p) => p.content.type === "single-select");

  const statusProp = eligible.find((p) => p.name.toLowerCase() === "status");
  if (statusProp) {
    return statusProp.id;
  }

  const latest = eligible
    .filter((p) => p.tool.type === "manual-input")
    .toSorted((a, b) => instantEpoch(b.createdAt) - instantEpoch(a.createdAt))
    .at(0);

  return latest?.id ?? "";
};
