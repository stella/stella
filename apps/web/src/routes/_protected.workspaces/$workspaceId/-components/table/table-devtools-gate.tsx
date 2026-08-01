import { lazy, Suspense } from "react";

import { ClientOnly } from "@tanstack/react-router";

import type { WorkspaceTable } from "@/components/workspaces/table/types";
import { useDevStore } from "@/lib/dev-store";

const TableDevtools = lazy(async () => {
  const module =
    await import("@/routes/_protected.workspaces/$workspaceId/-components/table/table-devtools");
  return { default: module.default };
});

export default function TableDevtoolsGate({
  table,
}: {
  table: WorkspaceTable;
}) {
  const tanstackDevtools = useDevStore((state) => state.tanstackDevtools);

  if (!tanstackDevtools) {
    return null;
  }

  return (
    <ClientOnly>
      <Suspense fallback={null}>
        <TableDevtools table={table} />
      </Suspense>
    </ClientOnly>
  );
}
