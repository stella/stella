import { panic } from "better-result";

import {
  orderKanbanCellsByColumns,
  resolveKanbanGrouping,
  type KanbanBoardCell,
  type KanbanBoardColumn,
  type KanbanBoardLane,
  type KanbanBoardMatrix,
  type KanbanBuiltInGroup,
  type KanbanGroup,
  type KanbanGroupOption,
  type KanbanGrouping,
  type KanbanSchema,
} from "@stll/ui/kanban";

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

export type KanbanSavedAxisState<TGroupId extends string = string> = {
  emptyGroups: KanbanEmptyGroupVisibility;
  groupBy: TGroupId;
  hiddenGroups: readonly KanbanSavedGroupReference[];
  orderedGroups: readonly KanbanSavedGroupReference[];
};

export type KanbanSavedSubgroupState<TGroupId extends string = string> =
  KanbanSavedAxisState<TGroupId> & {
    collapsedGroups: readonly KanbanSavedGroupReference[];
  };

/**
 * View state is deliberately separate from the board's domain data. It may
 * change visibility, order, and collapse, but cannot change a card's cell.
 */
export type KanbanSavedViewState<TGroupId extends string = string> = {
  group: KanbanSavedAxisState<TGroupId>;
  subgroup: KanbanSavedSubgroupState<TGroupId> | null;
  version: 1;
};

export type WorkspaceKanbanProperty<TGroupId extends string = string> =
  GenericProperty & {
    id: TGroupId;
    name: string;
  };

export type CreateWorkspaceKanbanSchemaParams<
  TRow,
  TBuiltInGroupId extends string,
  TProperty extends WorkspaceKanbanProperty,
> = {
  builtInGroups: readonly KanbanBuiltInGroup<TRow, TBuiltInGroupId>[];
  properties: readonly TProperty[];
};

type WorkspaceKanbanSchemaGroupId<
  TBuiltInGroupId extends string,
  TProperty extends WorkspaceKanbanProperty,
> = TBuiltInGroupId | TProperty["id"];

/**
 * Turns the authoritative workspace property model into board declarations.
 * Select options remain the sole source of property-derived columns and lanes.
 */
export const createWorkspaceKanbanSchema = <
  TRow,
  TBuiltInGroupId extends string,
  TProperty extends WorkspaceKanbanProperty,
>({
  builtInGroups,
  properties,
}: CreateWorkspaceKanbanSchemaParams<
  TRow,
  TBuiltInGroupId,
  TProperty
>): KanbanSchema<
  TRow,
  TProperty,
  WorkspaceKanbanSchemaGroupId<TBuiltInGroupId, TProperty>
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

export type WorkspaceKanbanGroupingChoice<TGroupId extends string = string> = {
  id: TGroupId;
  label: string;
  type: "built-in" | "property";
};

export type WorkspaceKanbanBuiltInGroupLabel<
  TRow,
  TGroupId extends string = string,
> = (group: KanbanBuiltInGroup<TRow, TGroupId>) => string;

/** Property-aware data for a Group or Sub-group picker. */
export const getWorkspaceKanbanGroupingChoices = <
  TRow,
  TProperty extends WorkspaceKanbanProperty<TGroupId>,
  TGroupId extends string = string,
>({
  getBuiltInGroupLabel,
  schema,
}: {
  getBuiltInGroupLabel: WorkspaceKanbanBuiltInGroupLabel<TRow, TGroupId>;
  schema: KanbanSchema<TRow, TProperty, TGroupId>;
}): WorkspaceKanbanGroupingChoice<TGroupId>[] => {
  const choices: WorkspaceKanbanGroupingChoice<TGroupId>[] = [];
  for (const group of schema.builtInGroups) {
    choices.push({
      id: group.id,
      label: getBuiltInGroupLabel(group),
      type: "built-in",
    });
  }
  for (const property of schema.properties) {
    if (schema.getPropertyOptions(property) === null) {
      continue;
    }
    choices.push({ id: property.id, label: property.name, type: "property" });
  }
  return choices;
};

export type WorkspaceKanbanGroupingPickerLabels = {
  control: string;
  none: string;
  placeholder: string;
};

export type WorkspaceKanbanGroupingPickerProps<
  TRow,
  TProperty extends WorkspaceKanbanProperty<TGroupId>,
  TGroupId extends string = string,
> = {
  allowNone: boolean;
  excludedGroupBy?: TGroupId | undefined;
  getBuiltInGroupLabel: WorkspaceKanbanBuiltInGroupLabel<TRow, TGroupId>;
  labels: WorkspaceKanbanGroupingPickerLabels;
  onValueChange: (groupBy: TGroupId | "") => void;
  schema: KanbanSchema<TRow, TProperty, TGroupId>;
  value: TGroupId | "";
};

export type ResolveWorkspaceKanbanViewParams<
  TRow,
  TProperty,
  TGroupId extends string = string,
> = {
  schema: KanbanSchema<TRow, TProperty, TGroupId>;
  state: KanbanSavedViewState<TGroupId>;
};

export type ResolvedWorkspaceKanbanView<
  TRow,
  TProperty,
  TGroupId extends string = string,
> = {
  group: KanbanGrouping<TRow, TProperty, TGroupId>;
  subgroup: KanbanGrouping<TRow, TProperty, TGroupId>;
};

/**
 * A property cannot control both axes. Rejecting that configuration here means
 * a later diagonal drag never has two contradictory assignments for one field.
 */
export const resolveWorkspaceKanbanView = <
  TRow,
  TProperty,
  TGroupId extends string = string,
>({
  schema,
  state,
}: ResolveWorkspaceKanbanViewParams<
  TRow,
  TProperty,
  TGroupId
>): ResolvedWorkspaceKanbanView<TRow, TProperty, TGroupId> => {
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

const containsGroup = (
  groups: readonly KanbanGroup[],
  group: KanbanGroup,
): boolean => groups.some((candidate) => candidate.value === group.value);

const orderGroups = (
  groups: readonly KanbanGroup[],
  orderedGroups: readonly KanbanSavedGroupReference[],
): KanbanGroup[] => {
  const ordered: KanbanGroup[] = [];
  for (const reference of orderedGroups) {
    const group = groups.find((candidate) =>
      sameGroupReference(reference, candidate),
    );
    if (group !== undefined && !containsGroup(ordered, group)) {
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
  group: KanbanBoardColumn,
  matrix: KanbanBoardMatrix<TRow>,
): boolean =>
  matrix.cells.every(
    (cell) =>
      cell.coordinate.column.type !== group.type ||
      (group.type === "group" &&
        cell.coordinate.column.type === "group" &&
        cell.coordinate.column.group.value !== group.group.value) ||
      (group.type === "destination" &&
        cell.coordinate.column.type === "destination" &&
        cell.coordinate.column.destination.id !== group.destination.id) ||
      cell.rows.length === 0,
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
  columns: KanbanBoardColumn[];
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
  const columns: KanbanBoardColumn[] = [
    ...orderGroups(
      matrix.columns
        .filter(
          (column): column is { group: KanbanGroup; type: "group" } =>
            column.type === "group",
        )
        .map((column) => column.group),
      state.group.orderedGroups,
    )
      .map((group) => ({ group, type: "group" as const }))
      .filter(
        (column) =>
          !refersToGroup(state.group.hiddenGroups, column.group) &&
          (state.group.emptyGroups === "show" || !isGroupEmpty(column, matrix)),
      ),
    ...matrix.columns.filter((column) => column.type === "destination"),
  ];
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
      const cells = orderKanbanCellsByColumns({
        cells: matrix.cells.filter((cell) =>
          lane.type === "none"
            ? cell.coordinate.lane.type === "none"
            : cell.coordinate.lane.type === "group" &&
              cell.coordinate.lane.group.value === lane.group.value,
        ),
        columns,
      });
      if (cells.length !== columns.length) {
        return panic("Kanban presentation lane is missing a declared cell");
      }
      return { cells, collapsed, lane };
    });
  return { columns, lanes, matrix };
};
