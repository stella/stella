import type { ReactNode } from "react";

import { ButtonFace } from "@stll/ui/control-face";
import { Frame } from "@stll/ui/frame";
import { FilterIcon } from "@stll/ui/icons";
import { Skeleton } from "@stll/ui/skeleton";
import {
  HEAD_CONTENT_CLASS,
  SortableHeadFace,
  Table,
  TableBody,
  TableCellFace,
  TableHead,
  TableHeader,
  TableHeadLabel,
  TableRow,
} from "@stll/ui/table-shell";

import { PendingText } from "@/components/pending-text";
import type { MattersColumnId, MattersSortKey } from "@/lib/workspaces/types";
import { isFilterableColumnId } from "@/lib/workspaces/types";
import {
  MATTERS_COLUMN_LABEL_KEYS,
  MATTERS_SORT_LABEL_KEYS,
} from "@/routes/_protected.workspaces/-hooks/matters-labels.logic";

/** A column of the matters table: its width, and the sort its head sets. */
type MattersTableColumn = {
  id: MattersColumnId | "name";
  widthPx: number;
  /** The sort the head toggles; `null` for a head that does not sort. */
  sortKey: MattersSortKey | null;
};

/**
 * The matters table's columns in order, the one model the loaded table and
 * its loading view both read. The name always shows; the member hides the
 * others.
 */
const MATTERS_TABLE_COLUMNS = [
  { id: "name", sortKey: "name", widthPx: 260 },
  { id: "client", sortKey: "clientName", widthPx: 240 },
  { id: "team", sortKey: null, widthPx: 160 },
  { id: "reference", sortKey: "reference", widthPx: 120 },
  { id: "entityCount", sortKey: "entityCount", widthPx: 96 },
  { id: "lastActivityAt", sortKey: "lastActivityAt", widthPx: 140 },
  { id: "createdAt", sortKey: "createdAt", widthPx: 120 },
] as const satisfies readonly MattersTableColumn[];

/** One of the table's columns, as the model lists it. */
export type MattersTableColumnEntry = (typeof MATTERS_TABLE_COLUMNS)[number];

export type MattersTableColumnId = MattersTableColumnEntry["id"];

/** The member's sort, as the heads show it. */
export type MattersTableSort = { key: MattersSortKey; desc: boolean };

/** The columns the member shows, in the table's order. */
export const visibleMattersTableColumns = (
  hiddenColumns: readonly MattersColumnId[],
): readonly MattersTableColumnEntry[] =>
  MATTERS_TABLE_COLUMNS.filter(
    (column) => column.id === "name" || !hiddenColumns.includes(column.id),
  );

type MattersTableShellProps = {
  columns: readonly MattersTableColumn[];
  /** The head cells, one per column. */
  header: ReactNode;
  /** The rows. */
  children: ReactNode;
};

/**
 * The matters table's one layout, drawn by both phases: the frame, the
 * horizontal scroller, the fixed column widths, the header row and the body.
 * The loaded table fills it with sortable heads and the matters; the loading
 * view with the heads' faces and placeholder rows.
 */
export const MattersTableShell = ({
  children,
  columns,
  header,
}: MattersTableShellProps) => (
  <Frame className="overflow-hidden rounded-lg sm:rounded-2xl">
    <div className="overflow-x-auto">
      <Table
        className="table-fixed"
        style={{
          minWidth: `${String(columns.reduce((sum, column) => sum + column.widthPx, 0))}px`,
        }}
      >
        <colgroup>
          {columns.map((column) => (
            <col
              key={column.id}
              style={{ width: `${String(column.widthPx)}px` }}
            />
          ))}
        </colgroup>
        <TableHeader>
          <TableRow>{header}</TableRow>
        </TableHeader>
        <TableBody>{children}</TableBody>
      </Table>
    </div>
  </Frame>
);

/** A head's class: the trigger after its label shows while the head is hovered. */
const MATTERS_TABLE_HEAD_CLASS = "group/header";

/**
 * The column filter's place after a filterable head's label, which the
 * loaded head fills with its trigger (shown on hover, or while a filter is
 * set), so the label does not move when it arrives.
 */
const ColumnFilterPending = () => (
  <ButtonFace
    className="opacity-0 pointer-coarse:opacity-64"
    size="icon-2xs"
    variant="muted"
  >
    <FilterIcon className="size-3 opacity-100" />
  </ButtonFace>
);

/** The direction a head shows for the member's sort. */
const sortDirectionFor = (
  sortKey: MattersSortKey,
  sort: MattersTableSort | undefined,
): "asc" | "desc" | null => {
  if (sort === undefined || sort.key !== sortKey) {
    return null;
  }
  return sort.desc ? "desc" : "asc";
};

/**
 * The header row while the matters load: each head's label (and the sort it
 * shows) in its face, the filter trigger's place kept. `sort` is the
 * member's sort, `undefined` while it is not read yet.
 */
const MattersTableHeadPending = ({
  columns,
  sort,
}: {
  columns: readonly MattersTableColumnEntry[];
  sort: MattersTableSort | undefined;
}) =>
  columns.map((column) => {
    const trailing = isFilterableColumnId(column.id) ? (
      <ColumnFilterPending />
    ) : null;
    if (column.sortKey === null) {
      return (
        <TableHead className={MATTERS_TABLE_HEAD_CLASS} key={column.id}>
          <span className={HEAD_CONTENT_CLASS}>
            <TableHeadLabel>
              <PendingText
                barClassName="w-12"
                id={MATTERS_COLUMN_LABEL_KEYS[column.id]}
              />
            </TableHeadLabel>
            {trailing}
          </span>
        </TableHead>
      );
    }
    return (
      <SortableHeadFace
        className={MATTERS_TABLE_HEAD_CLASS}
        key={column.id}
        sortDirection={sortDirectionFor(column.sortKey, sort)}
        trailing={trailing}
      >
        <PendingText
          barClassName="w-14"
          id={MATTERS_SORT_LABEL_KEYS[column.sortKey]}
        />
      </SortableHeadFace>
    );
  });

/** A bar on a cell's line of text, at that line's height. */
const CellLineBar = ({ className }: { className: string }) => (
  <span className="flex h-3.5 items-center">
    <Skeleton className={className} />
  </span>
);

/** What a column's cell draws while its matter loads. */
const MattersCellPending = ({
  columnId,
}: {
  columnId: MattersTableColumnId;
}) => {
  if (columnId === "name") {
    return (
      <div className="flex min-w-0 items-center gap-2">
        <Skeleton className="size-2 shrink-0 rounded-full" />
        <CellLineBar className="h-3 w-2/5" />
      </div>
    );
  }
  if (columnId === "team") {
    return (
      <div className="flex min-w-0 justify-end sm:justify-start">
        <div className="flex items-center -space-x-1">
          <Skeleton className="size-5 rounded-full sm:size-6" />
          <Skeleton className="size-5 rounded-full sm:size-6" />
          <Skeleton className="size-5 rounded-full sm:size-6" />
        </div>
      </div>
    );
  }
  if (columnId === "entityCount") {
    return <CellLineBar className="h-3 w-6" />;
  }
  // The client, the reference and the dates: one line of text.
  return <CellLineBar className="h-3 w-3/5" />;
};

/** Placeholder rows, about a screen of them. */
const MATTERS_TABLE_ROW_PENDING_KEYS = Array.from(
  { length: 8 },
  (_, slot) => `row-${String(slot)}`,
);

/** The table's rows while the matters load, one cell per shown column. */
const MattersTableRowsPending = ({
  columns,
}: {
  columns: readonly MattersTableColumnEntry[];
}) =>
  MATTERS_TABLE_ROW_PENDING_KEYS.map((rowKey) => (
    <TableRow aria-hidden="true" key={rowKey}>
      {columns.map((column) => (
        <TableCellFace key={column.id}>
          <MattersCellPending columnId={column.id} />
        </TableCellFace>
      ))}
    </TableRow>
  ));

/**
 * The matters table while the matters load: the member's columns at their
 * widths, the heads in their faces and placeholder rows.
 */
export const MattersTablePending = ({
  hiddenColumns,
  sort,
}: {
  hiddenColumns: readonly MattersColumnId[];
  sort: MattersTableSort;
}) => {
  const columns = visibleMattersTableColumns(hiddenColumns);
  return (
    <MattersTableShell
      columns={columns}
      header={<MattersTableHeadPending columns={columns} sort={sort} />}
    >
      <MattersTableRowsPending columns={columns} />
    </MattersTableShell>
  );
};
