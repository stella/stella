type ColumnLike = {
  id: string;
  getSize: () => number;
};

type CellLike = {
  column: {
    id: string;
  };
};

export type ColumnDropEdge = "left" | "right";

type OrderedColumnsInput<TColumn extends ColumnLike> = {
  leftColumns: readonly TColumn[];
  centerColumns: readonly TColumn[];
  rightColumns: readonly TColumn[];
};

export const getOrderedColumns = <TColumn extends ColumnLike>({
  leftColumns,
  centerColumns,
  rightColumns,
}: OrderedColumnsInput<TColumn>): TColumn[] => [
  ...leftColumns,
  ...centerColumns,
  ...rightColumns,
];

export const getOrderedCells = <TCell extends CellLike>(
  cells: readonly TCell[],
  columns: readonly ColumnLike[],
): TCell[] => {
  const cellsByColumnId = new Map(cells.map((cell) => [cell.column.id, cell]));
  const orderedCells: TCell[] = [];

  for (const column of columns) {
    const cell = cellsByColumnId.get(column.id);
    if (cell) {
      orderedCells.push(cell);
    }
  }

  return orderedCells;
};

export const getGridTemplateColumns = (
  columns: readonly ColumnLike[],
  trailingFillerWidth: number,
  endColumns: readonly ColumnLike[] = [],
) =>
  [
    ...columns.map((column) => `${column.getSize()}px`),
    `${trailingFillerWidth}px`,
    ...endColumns.map((column) => `${column.getSize()}px`),
  ].join(" ");

type ReorderColumnIdsOptions = {
  ids: readonly string[];
  sourceId: string;
  targetId: string;
  edge: ColumnDropEdge;
};

export const reorderColumnIds = ({
  ids,
  sourceId,
  targetId,
  edge,
}: ReorderColumnIdsOptions): string[] => {
  if (sourceId === targetId) {
    return [...ids];
  }

  const sourceIndex = ids.indexOf(sourceId);
  const targetIndex = ids.indexOf(targetId);
  if (sourceIndex === -1 || targetIndex === -1) {
    return [...ids];
  }

  const withoutSource = ids.toSpliced(sourceIndex, 1);
  const targetIndexAfterRemoval = withoutSource.indexOf(targetId);
  const insertIndex =
    edge === "left" ? targetIndexAfterRemoval : targetIndexAfterRemoval + 1;

  withoutSource.splice(insertIndex, 0, sourceId);

  return withoutSource;
};
