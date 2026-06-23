// Passive regression fixture for
// `no-static-devtools-import/no-static-devtools-import`.

import { lazy } from "react";

// oxlint-disable-next-line no-static-devtools-import/no-static-devtools-import
import { TanStackDevtools } from "@tanstack/react-devtools";
import type { ReactQueryDevtoolsPanel } from "@tanstack/react-query-devtools";

// oxlint-disable-next-line no-static-devtools-import/no-static-devtools-import
import TableDevtools from "@/routes/_protected.workspaces/$workspaceId/-components/table/table-devtools";

const LazyTanStackDevtoolsRoot = lazy(
  async () => await import("@/components/tanstack-devtools-root"),
);

export function StaticDevtoolsImportFixture({
  panel,
}: {
  panel: typeof ReactQueryDevtoolsPanel;
}) {
  return (
    <>
      <TanStackDevtools plugins={[]} />
      <LazyTanStackDevtoolsRoot sourceInspector={false} />
      <TableDevtools table={panel} />
    </>
  );
}
