import type {
  Column,
  ColumnDef,
  Header,
  Table as ReactTable,
} from "@tanstack/react-table";

import type { WorkspaceEntity } from "@/lib/types";

export type TableTreeNode = WorkspaceEntity & {
  children: TableTreeNode[];
};

export type WorkspaceTable = ReactTable<TableTreeNode>;
export type TableColumnDef = ColumnDef<TableTreeNode>;
export type TableColumn = Column<TableTreeNode>;
export type TableHeader = Header<TableTreeNode, unknown>;
