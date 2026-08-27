import type {
  KanbanBoardCell,
  KanbanBoardLane,
  KanbanBoardMatrix,
  KanbanBuiltInGroup,
  KanbanGroup,
  KanbanGroupOption,
  KanbanGrouping,
  KanbanSchema,
} from "@stll/ui/kanban";
import { resolveKanbanGrouping } from "@stll/ui/kanban";

import type { GenericProperty } from "./types";

export const KANBAN_EMPTY_GROUP_VISIBILITIES = {
  hide: "hide",
  show: "show",
} as const;

export type KanbanEmptyGroupVisibility =
  (typeof KANBAN_EMPTY_GROUP_VISIBILITIES)[keyof typeof KANBAN_EMPTY_GROUP_VISIBILITIES];

/** A persisted reference keeps a real option distinct from the No value lane. */
export type KanbanSavedGroupReference =
  | { type: "option"; value: string }
  | { type: "uncategorized" };

export type KanbanSavedAxisState = {
  emptyGroups: KanbanEmptyGroupVisibility;
  groupBy: string;
  hiddenGroups: readonly KanbanSavedGroupReference[];
  orderedGroups: readonly KanbanSavedGroupReference[];
};

export type KanbanSavedSubgroupState = KanbanSavedAxisState & {
  collapsedGroups: readonly KanbanSavedGroupReference[];
};

/**
 * View state is deliberately separate from the board's domain data. It may
 * change visibility, order, and collapse, but cannot change a card's cell.
 */
export type KanbanSavedViewState = {
  group: KanbanSavedAxisState;
  subgroup: KanbanSavedSubgroupState | null;
  version: 1;
};

export type WorkspaceKanbanProperty = GenericProperty & {
  id: string;
  name: string;
};

export type CreateWorkspaceKanbanSchemaParams<
  TRow,
  TProperty extends WorkspaceKanbanProperty,
> = {
  builtInGroups: readonly KanbanBuiltInGroup<TRow>[];
  properties: readonly TProperty[];
};

/**
 * Turns the authoritative workspace property model into board declarations.
 * Select options remain the sole source of property-derived columns and lanes.
 */
export const createWorkspaceKanbanSchema = <
  TRow,
  TProperty extends WorkspaceKanbanProperty,
>({
  builtInGroups,
  properties,
}: CreateWorkspaceKanbanSchemaParams<TRow, TProperty>): KanbanSchema<
  TRow,
  TProperty
> => ({
  builtInGroups,
  getPropertyId: (property) => property.id,
  getPropertyOptions: (property): readonly KanbanGroupOption[] | null => {
    if (property.content.type !== "single-select") {
      return null;
    }
    return property.content.options.map((option) => ({
      optionColor: option.color,
      value: option.value,
      label: option.value,
    }));
  },
  properties,
});

export type WorkspaceKanbanGroupingChoice = {
  id: string;
  label: string;
  type: "built-in" | "property";
};

/** Property-aware data for a Group or Sub-group picker. */
export const getWorkspaceKanbanGroupingChoices = <
  TRow,
  TProperty extends WorkspaceKanbanProperty,
>({
  schema,
}: {
  schema: KanbanSchema<TRow, TProperty>;
}): WorkspaceKanbanGroupingChoice[] => {
  const choices: WorkspaceKanbanGroupingChoice[] = [];
  for (const group of schema.builtInGroups) {
    choices.push({ id: group.id, label: group.id, type: "built-in" });
  }
  for (const property of schema.properties) {
    if (schema.getPropertyOptions(property) === null) {
      continue;
    }
    choices.push({ id: property.id, label: property.name, type: "property" });
  }
  return choices;
};

export type ResolveWorkspaceKanbanViewParams<TRow, TProperty> = {
  schema: KanbanSchema<TRow, TProperty>;
  state: KanbanSavedViewState;
};

export type ResolvedWorkspaceKanbanView<TRow, TProperty> = {
  group: KanbanGrouping<TRow, TProperty>;
  subgroup: KanbanGrouping<TRow, TProperty>;
};

/**
 * A property cannot control both axes. Rejecting that configuration here means
 * a later diagonal drag never has two contradictory assignments for one field.
 */
export const resolveWorkspaceKanbanView = <TRow, TProperty>({
  schema,
  state,
}: ResolveWorkspaceKanbanViewParams<
  TRow,
  TProperty
>): ResolvedWorkspaceKanbanView<TRow, TProperty> => {
  const group = resolveKanbanGrouping({ groupBy: state.group.groupBy, schema });
  const subgroup =
    state.subgroup === null || state.subgroup.groupBy === state.group.groupBy
      ? resolveKanbanGrouping({ groupBy: "", schema })
      : resolveKanbanGrouping({ groupBy: state.subgroup.groupBy, schema });
  return { group, subgroup };
};

const sameGroupReference = (
  reference: KanbanSavedGroupReference,
  group: KanbanGroup,
): boolean =>
  reference.type === "uncategorized"
    ? group.value === null
    : group.value === reference.value;

const refersToGroup = (
  references: readonly KanbanSavedGroupReference[],
  group: KanbanGroup,
): boolean =>
  references.some((reference) => sameGroupReference(reference, group));

const orderGroups = (
  groups: readonly KanbanGroup[],
  orderedGroups: readonly KanbanSavedGroupReference[],
): KanbanGroup[] => {
  const ordered: KanbanGroup[] = [];
  for (const reference of orderedGroups) {
    const group = groups.find((candidate) =>
      sameGroupReference(reference, candidate),
    );
    if (group !== undefined) {
      ordered.push(group);
    }
  }
  for (const group of groups) {
    if (!refersToGroup(orderedGroups, group)) {
      ordered.push(group);
    }
  }
  return ordered;
};

const isGroupEmpty = <TRow>(
  group: KanbanGroup,
  matrix: KanbanBoardMatrix<TRow>,
): boolean =>
  matrix.cells.every(
    (cell) =>
      cell.coordinate.column.value !== group.value || cell.rows.length === 0,
  );

const isLaneEmpty = <TRow>(
  lane: KanbanBoardLane,
  matrix: KanbanBoardMatrix<TRow>,
): boolean =>
  matrix.cells.every(
    (cell) =>
      cell.coordinate.lane.type !== lane.type ||
      (lane.type === "group" &&
        cell.coordinate.lane.type === "group" &&
        cell.coordinate.lane.group.value !== lane.group.value) ||
      cell.rows.length === 0,
  );

export type KanbanPresentedLane<TRow> = {
  cells: KanbanBoardCell<TRow>[];
  collapsed: boolean;
  lane: KanbanBoardLane;
};

export type KanbanBoardPresentation<TRow> = {
  columns: KanbanGroup[];
  lanes: KanbanPresentedLane<TRow>[];
  matrix: KanbanBoardMatrix<TRow>;
};

/**
 * Apply saved presentation state without rebuilding the matrix. This preserves
 * the canonical placement invariant while letting a view hide empty groups,
 * individually hide groups, reorder them, and collapse swimlanes.
 */
export const presentKanbanBoard = <TRow>({
  matrix,
  state,
}: {
  matrix: KanbanBoardMatrix<TRow>;
  state: KanbanSavedViewState;
}): KanbanBoardPresentation<TRow> => {
  const columns = orderGroups(matrix.columns, state.group.orderedGroups).filter(
    (group) =>
      !refersToGroup(state.group.hiddenGroups, group) &&
      (state.group.emptyGroups === "show" || !isGroupEmpty(group, matrix)),
  );
  const subgroupState = state.subgroup;
  const orderedLanes =
    subgroupState === null || matrix.lanes.some((lane) => lane.type === "none")
      ? matrix.lanes
      : orderGroups(
          matrix.lanes
            .filter(
              (lane): lane is { group: KanbanGroup; type: "group" } =>
                lane.type === "group",
            )
            .map((lane) => lane.group),
          subgroupState.orderedGroups,
        ).map((group) => ({ group, type: "group" as const }));
  const lanes = orderedLanes
    .filter((lane) => {
      if (lane.type === "none" || subgroupState === null) {
        return true;
      }
      return (
        !refersToGroup(subgroupState.hiddenGroups, lane.group) &&
        (subgroupState.emptyGroups === "show" || !isLaneEmpty(lane, matrix))
      );
    })
    .map((lane) => {
      const collapsed =
        lane.type === "group" &&
        subgroupState !== null &&
        refersToGroup(subgroupState.collapsedGroups, lane.group);
      const cells = matrix.cells.filter(
        (cell) =>
          columns.some(
            (column) => column.value === cell.coordinate.column.value,
          ) &&
          (lane.type === "none"
            ? cell.coordinate.lane.type === "none"
            : cell.coordinate.lane.type === "group" &&
              cell.coordinate.lane.group.value === lane.group.value),
      );
      return { cells, collapsed, lane };
    });
  return { columns, lanes, matrix };
};
