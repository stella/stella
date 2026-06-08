import { useTanStackTableDevtools } from "@tanstack/react-table-devtools";

import type { WorkspaceTable } from "@/routes/_protected.workspaces/$workspaceId/-components/table/types";

type TableDevtoolsProps = {
  table: WorkspaceTable;
};

// Mounted only in development, behind a lazy import (see `table-layout.tsx`),
// so the Solid-based devtools panel and its dependencies never reach the
// production client or SSR bundles. Registers the live table instance with
// the TanStack devtools panel wired in `dev-root.tsx`.
export default function TableDevtools({ table }: TableDevtoolsProps) {
  useTanStackTableDevtools(table);
  return null;
}
