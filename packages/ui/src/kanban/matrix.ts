import { panic } from "better-result";

import {
  getKanbanGroups,
  getKanbanGroupingPropertyId,
  isKanbanGroupingRenderable,
  resolveKanbanGroupOptions,
  selectKanbanRows,
} from "./grouping";
import type { KanbanGroup, KanbanGrouping } from "./grouping";

/** Which axis of a board a grouping controls. */
export const KANBAN_BOARD_AXES = {
  group: "group",
  subgroup: "subgroup",
} as const;

export type KanbanBoardAxis =
  (typeof KANBAN_BOARD_AXES)[keyof typeof KANBAN_BOARD_AXES];

/** The optional horizontal swimlane dimension is intentionally explicit. */
export type KanbanBoardLane =
  | { type: "none" }
  | { group: KanbanGroup; type: "group" };

export type KanbanBoardCoordinate = {
  column: KanbanGroup;
  lane: KanbanBoardLane;
};

export type KanbanBoardCell<TRow> = {
  coordinate: KanbanBoardCoordinate;
  rows: TRow[];
};

/**
 * The full, ordered cartesian board. Presentation may hide or collapse parts
 * of it, but it must not derive cards independently: every board row is in
 * exactly one cell here before that presentation step.
 */
export type KanbanBoardMatrix<TRow> = {
  cells: KanbanBoardCell<TRow>[];
  columns: KanbanGroup[];
  lanes: KanbanBoardLane[];
  rows: TRow[];
};

export type ResolveKanbanGroupValueParams<
  TRow,
  TProperty,
  TGroupId extends string = string,
> = {
  grouping: KanbanGrouping<TRow, TProperty, TGroupId>;
  row: TRow;
};

export type BuildKanbanBoardMatrixParams<
  TRow,
  TProperty,
  TGroupId extends string = string,
> = {
  /** The vertical board columns. This must be a renderable grouping. */
  group: KanbanGrouping<TRow, TProperty, TGroupId>;
  /** Optional horizontal swimlanes. `none` makes this a one-lane board. */
  subgroup: KanbanGrouping<TRow, TProperty, TGroupId>;
  rows: readonly TRow[];
  uncategorizedLabel: string;
  resolveGroupValue: (
    params: ResolveKanbanGroupValueParams<TRow, TProperty, TGroupId>,
  ) => string | null;
};

const optionValueKey = (value: string | null): string =>
  value === null ? "null" : `string:${value.length}:${value}`;

export type OrderKanbanCellsByColumnsParams<TRow> = {
  cells: readonly KanbanBoardCell<TRow>[];
  columns: readonly KanbanGroup[];
};

/** Apply the visible header order to any lane's cells. */
export const orderKanbanCellsByColumns = <TRow>({
  cells,
  columns,
}: OrderKanbanCellsByColumnsParams<TRow>): KanbanBoardCell<TRow>[] => {
  const orderByValue = new Map(
    columns.map((column, index) => [optionValueKey(column.value), index]),
  );
  const getColumnOrder = (cell: KanbanBoardCell<TRow>) => {
    const order = orderByValue.get(
      optionValueKey(cell.coordinate.column.value),
    );
    return order ?? panic("Visible Kanban cell has no column order");
  };
  return cells
    .filter((cell) =>
      orderByValue.has(optionValueKey(cell.coordinate.column.value)),
    )
    .toSorted((left, right) => getColumnOrder(left) - getColumnOrder(right));
};

const cellKey = ({ column, lane }: KanbanBoardCoordinate): string =>
  `${optionValueKey(column.value)}|${lane.type === "none" ? "none" : optionValueKey(lane.group.value)}`;

const groupContainsValue = (
  groups: readonly KanbanGroup[],
  value: string | null,
): boolean => groups.some((group) => group.value === value);

const normalizeGroupValue = (
  groups: readonly KanbanGroup[],
  value: string | null,
): string | null => (groupContainsValue(groups, value) ? value : null);

const getRenderableGroups = <TRow, TProperty, TGroupId extends string>(
  grouping: KanbanGrouping<TRow, TProperty, TGroupId>,
  uncategorizedLabel: string,
): KanbanGroup[] => {
  if (!isKanbanGroupingRenderable(grouping)) {
    return [];
  }
  return getKanbanGroups(
    resolveKanbanGroupOptions(grouping),
    uncategorizedLabel,
  );
};

const makeLanes = <TRow, TProperty, TGroupId extends string>(
  subgroup: KanbanGrouping<TRow, TProperty, TGroupId>,
  uncategorizedLabel: string,
): KanbanBoardLane[] => {
  if (subgroup.type === "none") {
    return [{ type: "none" }];
  }
  return getRenderableGroups(subgroup, uncategorizedLabel).map((group) => ({
    group,
    type: "group",
  }));
};

/**
 * Resolve the board's one source of placement truth.
 *
 * A subgroup never filters the primary board scope. A row outside a subgroup's
 * declared values goes to its explicit No value lane, rather than disappearing.
 */
export const buildKanbanBoardMatrix = <
  TRow,
  TProperty,
  TGroupId extends string = string,
>({
  group,
  subgroup,
  rows,
  uncategorizedLabel,
  resolveGroupValue,
}: BuildKanbanBoardMatrixParams<
  TRow,
  TProperty,
  TGroupId
>): KanbanBoardMatrix<TRow> => {
  if (!isKanbanGroupingRenderable(group)) {
    return { cells: [], columns: [], lanes: [], rows: [] };
  }
  const columns = getRenderableGroups(group, uncategorizedLabel);
  const scopedRows = selectKanbanRows(rows, group);
  const hasRenderableSubgroup = isKanbanGroupingRenderable(subgroup);
  const lanes = hasRenderableSubgroup
    ? makeLanes(subgroup, uncategorizedLabel)
    : [{ type: "none" as const }];
  const cells: KanbanBoardCell<TRow>[] = [];
  const cellsByKey = new Map<string, KanbanBoardCell<TRow>>();

  for (const lane of lanes) {
    for (const column of columns) {
      const coordinate = { column, lane };
      const cell: KanbanBoardCell<TRow> = { coordinate, rows: [] };
      cells.push(cell);
      cellsByKey.set(cellKey(coordinate), cell);
    }
  }

  for (const row of scopedRows) {
    const columnValue = normalizeGroupValue(
      columns,
      resolveGroupValue({ grouping: group, row }),
    );
    const lane = !hasRenderableSubgroup
      ? { type: "none" as const }
      : {
          group: {
            value: normalizeGroupValue(
              lanes
                .filter(
                  (
                    candidate,
                  ): candidate is { group: KanbanGroup; type: "group" } =>
                    candidate.type === "group",
                )
                .map((candidate) => candidate.group),
              resolveGroupValue({ grouping: subgroup, row }),
            ),
            label: "",
          },
          type: "group" as const,
        };
    const column = columns.find((candidate) => candidate.value === columnValue);
    const resolvedLane =
      lane.type === "none"
        ? lane
        : lanes.find(
            (candidate): candidate is { group: KanbanGroup; type: "group" } =>
              candidate.type === "group" &&
              candidate.group.value === lane.group.value,
          );

    if (column === undefined || resolvedLane === undefined) {
      return panic("Kanban matrix cannot place a row in a declared cell");
    }

    const cell = cellsByKey.get(cellKey({ column, lane: resolvedLane }));
    if (cell === undefined) {
      return panic("Kanban matrix cell declaration is incomplete");
    }
    cell.rows.push(row);
  }

  return { cells, columns, lanes, rows: scopedRows };
};

export type KanbanDropAxisChange<TGroupId extends string = string> = {
  groupBy: TGroupId;
  value: string | null;
};

/** A complete, atomic move request for a domain mutation adapter. */
export type KanbanDropIntent<TCardId, TGroupId extends string = string> = {
  cardId: TCardId;
  changes: readonly KanbanDropAxisChange<TGroupId>[];
  type: "move";
};

export type CreateKanbanDropIntentParams<
  TRow,
  TProperty,
  TCardId,
  TGroupId extends string = string,
> = {
  cardId: TCardId;
  group: KanbanGrouping<TRow, TProperty, TGroupId>;
  source: KanbanBoardCoordinate;
  subgroup: KanbanGrouping<TRow, TProperty, TGroupId>;
  target: KanbanBoardCoordinate;
};

/**
 * Builds a single mutation payload for a pointer, touch, or keyboard drop.
 * Diagonal drops carry both changes together; an adapter must commit this
 * intent atomically or reject it as a whole.
 */
export const createKanbanDropIntent = <
  TRow,
  TProperty,
  TCardId,
  TGroupId extends string = string,
>({
  cardId,
  group,
  source,
  subgroup,
  target,
}: CreateKanbanDropIntentParams<
  TRow,
  TProperty,
  TCardId,
  TGroupId
>): KanbanDropIntent<TCardId, TGroupId> | null => {
  const groupBy = getKanbanGroupingPropertyId(group);
  const subgroupBy = getKanbanGroupingPropertyId(subgroup);
  if (groupBy === null || (subgroupBy !== null && subgroupBy === groupBy)) {
    return null;
  }

  const changes: KanbanDropAxisChange<TGroupId>[] = [];
  if (source.column.value !== target.column.value) {
    changes.push({ groupBy, value: target.column.value });
  }
  if (
    subgroupBy !== null &&
    source.lane.type === "group" &&
    target.lane.type === "group" &&
    source.lane.group.value !== target.lane.group.value
  ) {
    changes.push({ groupBy: subgroupBy, value: target.lane.group.value });
  }

  if (changes.length === 0) {
    return null;
  }
  return { cardId, changes, type: "move" };
};
