/**
 * The workspace's instance of the kit's kanban schema.
 *
 * The kit decides how a board resolves its columns; this module says what a
 * workspace board's columns are made of. Everything domain-specific — task
 * statuses, entity kinds, the option colours a select property carries — is
 * declared here and nowhere else.
 */

import {
  ENTITY_KINDS,
  TASK_STATUSES as TASK_STATUS_ORDER,
} from "@stll/api-contract";
import type { EntityKind, TaskStatus } from "@stll/api-contract";
import type { OptionColor } from "@stll/api/types";
import type {
  KanbanBuiltInGroup,
  KanbanGrouping,
  KanbanGroupOption,
  KanbanSchema,
} from "@stll/ui/kanban";
import { resolveKanbanGrouping } from "@stll/ui/kanban";

import {
  getInternalPropertyId,
  resolveKanbanGroupBy,
} from "@/components/workspaces/entity-utils";
import { resolveOptionColor } from "@/components/workspaces/property-utils";
import type { WorkspaceEntity, WorkspaceProperty } from "@/lib/types";

export type WorkspaceKanbanSchema = KanbanSchema<
  WorkspaceEntity,
  WorkspaceProperty
>;

export type WorkspaceKanbanGrouping = KanbanGrouping<
  WorkspaceEntity,
  WorkspaceProperty
>;

/** All task statuses in the order they should appear as groups. */
export { TASK_STATUS_ORDER };

/** Every status carries a label. A partial map would render a raw column
 *  heading such as "in_progress" to the user. */
export type TaskStatusLabels = Record<TaskStatus, string>;

export type EntityKindLabels = Record<EntityKind, string>;

const STATUS_OPTION_COLORS = {
  open: "gray",
  in_progress: "blue",
  in_review: "amber",
  done: "green",
  cancelled: "red",
} as const satisfies Record<TaskStatus, OptionColor>;

const toGroupOption = (value: string, label: string, color: OptionColor) => {
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
    toGroupOption(status, labels[status], STATUS_OPTION_COLORS[status]),
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

export const isGroupableProperty = (property: WorkspaceProperty): boolean =>
  property.content.type === "single-select" ||
  property.content.type === "multi-select";

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

export type WorkspaceKanbanSchemaParams = {
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

/** A subgroup is opt-in and can never repeat the primary grouping. */
export const resolveWorkspaceKanbanSubgroup = (
  configuredSubgroupBy: string,
  groupByPropertyId: string | null,
  schema: WorkspaceKanbanSchema,
): WorkspaceKanbanGrouping =>
  resolveKanbanGrouping({
    groupBy:
      configuredSubgroupBy === groupByPropertyId ? "" : configuredSubgroupBy,
    schema,
  });

/** Resolve the stored value that places an entity on either board axis. */
export const resolveWorkspaceKanbanGroupValue = (
  grouping: WorkspaceKanbanGrouping,
  entity: WorkspaceEntity,
): string | null => {
  if (grouping.type === "none") {
    return null;
  }
  if (grouping.type === "property") {
    const content = entity.fields[grouping.property.id]?.content;
    return content?.type === "single-select" ? content.value : null;
  }

  switch (grouping.group.id) {
    case "_status":
      return entity.status;
    case "_kind":
      return entity.kind;
    case "_created-by":
      return entity.createdBy;
    default:
      return null;
  }
};
