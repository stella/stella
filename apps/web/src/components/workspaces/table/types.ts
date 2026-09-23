import type {
  Cell,
  CellContext,
  Column,
  ColumnDef,
  Header,
  HeaderContext,
  ReactTable,
  Row,
} from "@tanstack/react-table";

import type { EntityViewRow } from "@/components/entity-views/types";
import type { WorkspaceTableFeatures } from "@/components/workspaces/table/table-features";
import type { Decision } from "@/features/case-law/components/decision-cells";
import type { StatuteListItem } from "@/features/statutes/queries/statutes";
import type { WorkspaceEntity } from "@/lib/types";

export type TableTreeNode = WorkspaceEntity & {
  children: TableTreeNode[];
};

/** One decision as a row: the public results table's row kind. */
export type DecisionRowData = {
  kind: "decision";
  decision: Decision;
  /** Decisions never nest; the table reads children for every row kind. */
  children: [];
};

/** One statute, at its latest wording: the public statute list's row kind. */
export type StatuteRowData = {
  kind: "statute";
  statute: StatuteListItem;
  /** Statutes never nest; the table reads children for every row kind. */
  children: [];
};

/**
 * What a row of a workspace table holds.
 *
 * The kinds discriminate on `kind`: an entity row carries its entity kind
 * (`document`, `folder`, `task`, …) and a decision or statute row carries
 * `"decision"` or `"statute"`, which are not entity kinds. A host binds the
 * table to one of them — the aliases below default to the entity row, so
 * entity code reads unchanged — and supplies the behaviours that kind has
 * through a `TableRowHost`.
 */
export type TableRowData =
  | TableTreeNode
  | DecisionRowData
  | StatuteRowData
  | EntityViewRow;

// Keep the feature-set generic centralized so table consumers cannot drift from
// the capabilities registered in `table-features.ts`.
export type WorkspaceTable<TRow extends TableRowData = TableTreeNode> =
  ReactTable<WorkspaceTableFeatures, TRow>;
export type TableColumnDef<TRow extends TableRowData = TableTreeNode> =
  ColumnDef<WorkspaceTableFeatures, TRow>;
export type TableColumn<TRow extends TableRowData = TableTreeNode> = Column<
  WorkspaceTableFeatures,
  TRow
>;
export type TableHeader<TRow extends TableRowData = TableTreeNode> = Header<
  WorkspaceTableFeatures,
  TRow
>;
export type TableCell<TRow extends TableRowData = TableTreeNode> = Cell<
  WorkspaceTableFeatures,
  TRow
>;
export type TableRow<TRow extends TableRowData = TableTreeNode> = Row<
  WorkspaceTableFeatures,
  TRow
>;
export type TableCellContext<
  TValue = unknown,
  TRow extends TableRowData = TableTreeNode,
> = CellContext<WorkspaceTableFeatures, TRow, TValue>;
export type TableHeaderContext<
  TValue = unknown,
  TRow extends TableRowData = TableTreeNode,
> = HeaderContext<WorkspaceTableFeatures, TRow, TValue>;
