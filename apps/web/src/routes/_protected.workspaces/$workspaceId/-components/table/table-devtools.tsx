import { useTanStackTableDevtools } from "@tanstack/react-table-devtools";

import type { WorkspaceTableFeatures } from "@/components/workspaces/table/table-features";
import type {
  TableTreeNode,
  WorkspaceTable,
} from "@/components/workspaces/table/types";

type TableDevtoolsProps = {
  table: WorkspaceTable;
};

// Register the live table instance with the dev-only TanStack panel.
export default function TableDevtools({ table }: TableDevtoolsProps) {
  useTanStackTableDevtools<WorkspaceTableFeatures, TableTreeNode>(table);
  return null;
}
