import { useTanStackTableDevtools } from "@tanstack/react-table-devtools";

import type { WorkspaceTable } from "@/routes/_protected.workspaces/$workspaceId/-components/table/types";

type TableDevtoolsProps = {
  table: WorkspaceTable;
};

// Register the live table instance with the dev-only TanStack panel.
export default function TableDevtools({ table }: TableDevtoolsProps) {
  useTanStackTableDevtools(table);
  return null;
}
