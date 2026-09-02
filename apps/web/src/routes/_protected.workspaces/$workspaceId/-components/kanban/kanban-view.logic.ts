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
import type {
  KanbanBoardCell,
  KanbanBoardColumn,
  KanbanBoardLane,
  KanbanBoardMatrix,
  KanbanBuiltInGroup,
  KanbanGroup,
  KanbanGrouping,
  KanbanGroupOption,
  KanbanSchema,
} from "@stll/ui/kanban";
import {
  getKanbanBoardColumnIdentity,
  getKanbanBoardLaneIdentity,
  getKanbanGroups,
  isKanbanGroupingRenderable,
  resolveKanbanGroupOptions,
  resolveKanbanGrouping,
  selectKanbanRows,
} from "@stll/ui/kanban";

import {
  getInternalPropertyId,
  resolveKanbanGroupBy,
} from "@/components/workspaces/entity-utils";
import { resolveOptionColor } from "@/components/workspaces/property-utils";
import { getFormattingLocale } from "@/i18n/i18n-store";
import type { OptionColor } from "@/lib/api-contract";
import { compareByLocale } from "@/lib/collation";
import type {
  WorkspaceEntity,
  WorkspaceProperty,
  WorkspaceView,
} from "@/lib/types";

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

/**
 * Whether a kanban view's persisted sub-group is the assignee sub-group,
 * from the layout alone — no property schema needed. Assignee is a
 * reserved built-in sub-group id (see `assigneeGroup` above) that always
 * resolves the same way regardless of the workspace's properties, so a
 * direct comparison against the persisted `subgroupByPropertyId` agrees
 * with what `resolveWorkspaceKanbanSubgroup` would resolve to. Both the
 * kanban board's own window request and the route loader's preload derive
 * `includeAssignees` from this one function, so a preloaded fetch and the
 * component's own request can never disagree and force a refetch.
 */
export const windowIncludesAssignees = (view: WorkspaceView): boolean =>
  view.layout.type === "kanban" &&
  view.layout.subgroupByPropertyId === getInternalPropertyId("assignee");

const personGroupValue = (content: {
  userId: string | null;
  name: string;
}): string =>
  content.userId === null
    ? `unlinked-person:${content.name}`
    : `workspace-user:${content.userId}`;

const authorGroupValue = ({
  createdByUserId,
}: WorkspaceEntity): string | null =>
  createdByUserId === null ? null : `workspace-user:${createdByUserId}`;

const WORKSPACE_USER_LANE_PREFIX = "workspace-user:";

const assigneeGroupValue = (userId: string): string =>
  `${WORKSPACE_USER_LANE_PREFIX}${userId}`;

/** The user id behind an assignee lane value, or `null` for Unassigned. */
export const parseAssigneeLaneUserId = (value: string | null): string | null =>
  value?.startsWith(WORKSPACE_USER_LANE_PREFIX)
    ? value.slice(WORKSPACE_USER_LANE_PREFIX.length)
    : null;

export type AssigneeLaneDropIntent = {
  removeUserId: string | null;
  addUserId: string | null;
};

/**
 * The assignee mutations a card's move between assignee lanes calls for:
 * lane X to lane Y removes X and adds Y, Unassigned to Y only adds Y, X to
 * Unassigned only removes X, and staying in the same lane calls for nothing.
 */
export const resolveAssigneeLaneDropIntent = (
  sourceLaneValue: string | null,
  targetLaneValue: string | null,
): AssigneeLaneDropIntent => {
  if (sourceLaneValue === targetLaneValue) {
    return { removeUserId: null, addUserId: null };
  }
  return {
    removeUserId: parseAssigneeLaneUserId(sourceLaneValue),
    addUserId: parseAssigneeLaneUserId(targetLaneValue),
  };
};

/**
 * Every assignee lane value a row belongs to (fan-out), `[]` when the task
 * carries no assignees (the Unassigned lane). Order follows the row's
 * `assignees` array, which the API returns grouped per entity with no
 * particular ordering guarantee across rows.
 */
export const resolveWorkspaceKanbanAssigneeLaneValues = (
  entity: WorkspaceEntity,
): string[] =>
  entity.assignees.map((assignee) => assigneeGroupValue(assignee.userId));

/** Person and author lanes come from the loaded rows rather than a fixed
 * schema option list. Each identity keeps its real avatar with the lane. */
export const resolveWorkspaceKanbanDynamicSubgroup = (
  subgroup: WorkspaceKanbanGrouping,
  rows: readonly WorkspaceEntity[],
): WorkspaceKanbanGrouping => {
  const optionsByValue = new Map<string, KanbanGroupOption>();

  if (
    subgroup.type === "built-in" &&
    subgroup.group.id === getInternalPropertyId("created-by")
  ) {
    for (const row of rows) {
      const value = authorGroupValue(row);
      if (value === null || row.createdBy === null) {
        continue;
      }
      optionsByValue.set(value, {
        value,
        label: row.createdBy,
        image: row.createdByImage,
      });
    }
    return {
      type: "built-in",
      propertyId: subgroup.propertyId,
      group: { ...subgroup.group, options: [...optionsByValue.values()] },
    };
  }

  if (
    subgroup.type === "built-in" &&
    subgroup.group.id === getInternalPropertyId("assignee")
  ) {
    for (const row of rows) {
      for (const assignee of row.assignees) {
        if (assignee.name === null) {
          continue;
        }
        optionsByValue.set(assigneeGroupValue(assignee.userId), {
          value: assigneeGroupValue(assignee.userId),
          label: assignee.name,
          image: assignee.image,
        });
      }
    }
    // Lanes order by label, same as the fixed Unassigned bucket that always
    // lands last (appended by `getKanbanGroups`, never sorted into place).
    const compareLabels = compareByLocale(getFormattingLocale());
    const options = [...optionsByValue.values()].toSorted((a, b) =>
      compareLabels(a.label, b.label),
    );
    return {
      type: "built-in",
      propertyId: subgroup.propertyId,
      group: { ...subgroup.group, options },
    };
  }

  if (
    subgroup.type !== "property" ||
    subgroup.property.content.type !== "person"
  ) {
    return subgroup;
  }

  for (const row of rows) {
    const content = row.fields[subgroup.property.id]?.content;
    if (content?.type !== "person") {
      continue;
    }
    const value = personGroupValue(content);
    optionsByValue.set(value, {
      value,
      label: content.name,
      image: content.image,
    });
  }
  return {
    type: "property",
    propertyId: subgroup.propertyId,
    property: subgroup.property,
    options: [...optionsByValue.values()],
  };
};

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
    if (content?.type === "single-select") {
      return content.value;
    }
    return content?.type === "person" ? personGroupValue(content) : null;
  }

  switch (grouping.group.id) {
    case "_status":
      return entity.status;
    case "_kind":
      return entity.kind;
    case "_created-by":
      return authorGroupValue(entity);
    case "_assignee": {
      // A row can carry several assignees, so no single value can represent
      // every lane it belongs to; this keeps the single-valued contract the
      // generic matrix relies on by reporting the first. The real fan-out
      // across every assignee lane happens in `buildKanbanAssigneeMatrix`.
      const first = entity.assignees.at(0);
      return first === undefined ? null : assigneeGroupValue(first.userId);
    }
    default:
      return null;
  }
};

type CanMoveCardToSubgroupLaneOptions = {
  subgroup: WorkspaceKanbanGrouping;
  entity: WorkspaceEntity;
  targetLaneValue: string | null;
};

/** Writable property lanes may change, as does the assignee sub-group
 * (subject to the task's own read-only state, mirroring the assignees-add
 * and assignees-remove handler guards). Every other read-only lane accepts
 * primary-axis moves only when the card stays in its current lane. */
export const canMoveCardToSubgroupLane = ({
  subgroup,
  entity,
  targetLaneValue,
}: CanMoveCardToSubgroupLaneOptions): boolean => {
  if (subgroup.type === "property") {
    return true;
  }
  if (
    subgroup.type === "built-in" &&
    subgroup.group.id === getInternalPropertyId("assignee")
  ) {
    // The assignee sub-group is offered only on a view provably restricted to
    // tasks (view-toolbar.tsx's `allowAssigneeGrouping`), and the underlying
    // assignees-add/assignees-remove/assignees-move endpoints only ever
    // accept a task entity. A persisted or hand-edited layout could still
    // hand this branch a non-task row (the view's filters changed after the
    // layout was saved); refuse the move rather than let it reach those
    // task-only endpoints.
    return entity.kind === "task" && !entity.readOnly;
  }
  return resolveWorkspaceKanbanGroupValue(subgroup, entity) === targetLaneValue;
};

const normalizeToGroupValue = (
  groups: readonly KanbanGroup[],
  value: string | null,
): string | null =>
  groups.some((candidate) => candidate.value === value) ? value : null;

export type BuildKanbanAssigneeMatrixParams = {
  /** The vertical board columns (e.g. status); unaffected by the fan-out. */
  group: WorkspaceKanbanGrouping;
  /** The assignee sub-group, already resolved dynamically over `rows`. */
  assigneeSubgroup: WorkspaceKanbanGrouping;
  rows: readonly WorkspaceEntity[];
  uncategorizedLabel: string;
};

/**
 * `buildKanbanBoardMatrix` places every row in exactly one cell — a row
 * outside that invariant makes it panic. A task can carry several
 * assignees, so it belongs in several lanes at once; this sibling builder
 * produces the identical `KanbanBoardMatrix` shape but pushes a row into
 * `cell.rows` once per lane it matches (its lane values from
 * `resolveWorkspaceKanbanAssigneeLaneValues`, or the Unassigned lane alone
 * when that list is empty), instead of enforcing one placement.
 *
 * `cell.rows` is the per-cell source of truth every renderer and lane count
 * reads; the top-level `rows` field stays the board's deduplicated scoped
 * rows (one entry per row, exactly what `buildKanbanBoardMatrix` means by
 * it), since nothing reads that top-level list for a per-lane total — a
 * row's repeated appearances only ever live inside `cell.rows`. Assignee
 * lanes are task-only (mirrors `canMoveCardToSubgroupLane` above), so a
 * non-task row — reachable only from a persisted or hand-edited layout that
 * no longer restricts the view to tasks — is filtered out of `scopedRows`
 * before either `cell.rows` or the top-level `rows` is built: it has no
 * valid lane, not even Unassigned, and must not surface anywhere a drag
 * could reach the task-only assignee endpoints.
 */
export const buildKanbanAssigneeMatrix = ({
  group,
  assigneeSubgroup,
  rows,
  uncategorizedLabel,
}: BuildKanbanAssigneeMatrixParams): KanbanBoardMatrix<WorkspaceEntity> => {
  if (!isKanbanGroupingRenderable(group)) {
    return { cells: [], columns: [], lanes: [], rows: [] };
  }

  const columnGroups = getKanbanGroups(
    resolveKanbanGroupOptions(group),
    uncategorizedLabel,
  );
  const columns: KanbanBoardColumn[] = columnGroups.map((columnGroup) => ({
    group: columnGroup,
    type: "group",
  }));

  const laneGroups = isKanbanGroupingRenderable(assigneeSubgroup)
    ? getKanbanGroups(
        resolveKanbanGroupOptions(assigneeSubgroup),
        uncategorizedLabel,
      )
    : [];
  const lanes: KanbanBoardLane[] = laneGroups.map((laneGroup) => ({
    group: laneGroup,
    type: "group",
  }));

  const cells: KanbanBoardCell<WorkspaceEntity>[] = [];
  const cellsByKey = new Map<string, KanbanBoardCell<WorkspaceEntity>>();
  for (const lane of lanes) {
    for (const column of columns) {
      const cell: KanbanBoardCell<WorkspaceEntity> = {
        coordinate: { column, lane },
        rows: [],
      };
      cells.push(cell);
      cellsByKey.set(
        `${getKanbanBoardColumnIdentity(column)}|${getKanbanBoardLaneIdentity(lane)}`,
        cell,
      );
    }
  }

  const scopedRows = selectKanbanRows(rows, group).filter(
    (row) => row.kind === "task",
  );
  for (const row of scopedRows) {
    const columnValue = normalizeToGroupValue(
      columnGroups,
      resolveWorkspaceKanbanGroupValue(group, row),
    );
    const column = columns.find(
      (candidate): candidate is Extract<KanbanBoardColumn, { type: "group" }> =>
        candidate.type === "group" && candidate.group.value === columnValue,
    );
    if (column === undefined) {
      continue;
    }

    const rowLaneValues = resolveWorkspaceKanbanAssigneeLaneValues(row);
    const targetLaneValues =
      rowLaneValues.length === 0 ? [null] : rowLaneValues;
    for (const rawLaneValue of targetLaneValues) {
      const laneValue = normalizeToGroupValue(laneGroups, rawLaneValue);
      const lane = lanes.find(
        (candidate): candidate is Extract<KanbanBoardLane, { type: "group" }> =>
          candidate.type === "group" && candidate.group.value === laneValue,
      );
      if (lane === undefined) {
        continue;
      }
      const cell = cellsByKey.get(
        `${getKanbanBoardColumnIdentity(column)}|${getKanbanBoardLaneIdentity(lane)}`,
      );
      cell?.rows.push(row);
    }
  }

  return { cells, columns, lanes, rows: scopedRows };
};
