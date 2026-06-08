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

// v9 core types are generic over the registered feature set. Baking
// `WorkspaceTableFeatures` in once here keeps every consumer free of the
// `<features, data, value>` boilerplate and guarantees the types track
// whatever `table-features.ts` registers.
// The `useTable` return type (core `Table` plus `.state`, `.Subscribe`,
// `.FlexRender`), so consumers can read `table.state` directly.
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
