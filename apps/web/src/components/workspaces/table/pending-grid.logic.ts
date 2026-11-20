import { getWorkspaceGridTemplateColumns } from "@/components/workspaces/table/workspace-table/internals-helpers";
import type {
  GridColumnGeometry,
  GridColumnsInput,
} from "@/components/workspaces/table/workspace-table/internals-helpers";
import type { StoredColumnSizing } from "@/lib/workspaces/stored-column-sizing.logic";

/** A table column before its column model exists: its id and widths. */
type PendingGridColumn = {
  id: string;
  size: number;
  minSize: number;
};

/** A column's geometry from its place in the layout, as the grid reads it. */
const geometry = (
  column: { id: string; size: number },
  pinned: boolean,
  start: number,
  isLastPinned: boolean,
): GridColumnGeometry => ({
  id: column.id,
  getSize: () => column.size,
  getIsPinned: () => (pinned ? "start" : false),
  getStart: () => start,
  getIsLastColumn: () => isLastPinned,
});

export type PendingTableGrid = GridColumnsInput & {
  /** `--workspace-table-columns`, as the loaded table sets it. */
  templateColumns: string;
  /** The columns' total width, below which the grid scrolls sideways. */
  tableWidth: number;
};

/**
 * A workspace table's grid before its column model exists, laid out the way
 * the table's column state lays it out: the columns at their widths (a width
 * a reader dragged in this browser wins, within the column's minimum), the
 * hidden ones left out, the order applied with the columns it does not name
 * after it in their own order, the pinned ones docked at the start, and the
 * add-property column, when the table has one, after the filler.
 */
export const layoutPendingGrid = ({
  addPropertyColumnId,
  columns,
  hiddenIds,
  orderIds,
  pinnedIds,
  sizing = {},
}: {
  /** The table's add-property column, which no width is kept for. */
  addPropertyColumnId?: string | undefined;
  columns: readonly PendingGridColumn[];
  hiddenIds: ReadonlySet<string>;
  orderIds: readonly string[];
  pinnedIds: readonly string[];
  /** The widths the table store holds for the view (`storedColumnSizing`). */
  sizing?: StoredColumnSizing | undefined;
}): PendingTableGrid => {
  const sized = columns.map((column) => ({
    id: column.id,
    size: Math.max(sizing[column.id] ?? column.size, column.minSize),
  }));
  const visible = sized.filter((column) => !hiddenIds.has(column.id));
  const byId = new Map(visible.map((column) => [column.id, column]));
  const pick = (ids: readonly string[]) =>
    ids.flatMap((id) => {
      const column = byId.get(id);
      return column === undefined ? [] : [column];
    });

  const named = pick(orderIds);
  const namedIds = new Set(named.map((column) => column.id));
  const ordered = [
    ...named,
    ...visible.filter((column) => !namedIds.has(column.id)),
  ];

  const pinned = pick(pinnedIds);
  const pinnedSet = new Set(pinned.map((column) => column.id));
  const center = ordered.filter((column) => !pinnedSet.has(column.id));

  let offset = 0;
  const startColumns = pinned.map((column, index) => {
    const placed = geometry(column, true, offset, index === pinned.length - 1);
    offset += column.size;
    return placed;
  });
  const centerColumns = center.map((column) =>
    geometry(column, false, 0, false),
  );
  const all = [...startColumns, ...centerColumns];
  const renderColumns = all.filter(
    (column) => column.id !== addPropertyColumnId,
  );
  const addPropertyColumn =
    all.find((column) => column.id === addPropertyColumnId) ?? null;
  return {
    renderColumns,
    addPropertyColumn,
    templateColumns: getWorkspaceGridTemplateColumns({
      renderColumns,
      addPropertyColumn,
    }),
    tableWidth: all.reduce((sum, column) => sum + column.getSize(), 0),
  };
};
