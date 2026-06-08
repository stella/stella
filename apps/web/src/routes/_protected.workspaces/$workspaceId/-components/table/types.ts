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

import type { WorkspaceEntity } from "@/lib/types";
import type { WorkspaceTableFeatures } from "@/routes/_protected.workspaces/$workspaceId/-components/table/table-features";

export type TableTreeNode = WorkspaceEntity & {
  children: TableTreeNode[];
};

// Keep the feature-set generic centralized so table consumers cannot drift from
// the capabilities registered in `table-features.ts`.
export type WorkspaceTable = ReactTable<WorkspaceTableFeatures, TableTreeNode>;
export type TableColumnDef = ColumnDef<WorkspaceTableFeatures, TableTreeNode>;
export type TableColumn = Column<WorkspaceTableFeatures, TableTreeNode>;
export type TableHeader = Header<WorkspaceTableFeatures, TableTreeNode>;
export type TableCell = Cell<WorkspaceTableFeatures, TableTreeNode>;
export type TableRow = Row<WorkspaceTableFeatures, TableTreeNode>;
export type TableCellContext<TValue = unknown> = CellContext<
  WorkspaceTableFeatures,
  TableTreeNode,
  TValue
>;
export type TableHeaderContext<TValue = unknown> = HeaderContext<
  WorkspaceTableFeatures,
  TableTreeNode,
  TValue
>;
