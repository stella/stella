/* oxlint-disable unicorn/prefer-module -- fixture: require is one of the load forms */

// Passive regression fixture for
// `no-static-devtools-import/no-static-devtools-import`.
//
// Devtools packages load only inside their lazy islands, and the islands load
// only through `import()`. Type-only imports and dynamic imports are allowed.

import { lazy } from "react";

// oxlint-disable-next-line no-static-devtools-import/no-static-devtools-import -- static package import
import { TanStackDevtools } from "@tanstack/react-devtools";
// expect-clean: no-static-devtools-import/no-static-devtools-import
import type { ReactQueryDevtoolsPanel } from "@tanstack/react-query-devtools";

// oxlint-disable-next-line no-static-devtools-import/no-static-devtools-import -- static import of a lazy island
import TableDevtools from "../../apps/web/src/routes/_protected.workspaces/$workspaceId/-components/table/table-devtools";

// expect-clean: no-static-devtools-import/no-static-devtools-import
const LazyTanStackDevtoolsRoot = lazy(
  async () =>
    await import("../../apps/web/src/components/tanstack-devtools-root"),
);
// expect-clean: no-static-devtools-import/no-static-devtools-import
const pendingQueryDevtools = import("@tanstack/react-query-devtools");
// oxlint-disable-next-line no-static-devtools-import/no-static-devtools-import -- require loads eagerly
const routerDevtools = require("@tanstack/react-router-devtools");

// oxlint-disable-next-line no-static-devtools-import/no-static-devtools-import -- star re-export
export * from "@tanstack/react-table-devtools";
// oxlint-disable-next-line no-static-devtools-import/no-static-devtools-import -- named re-export of a lazy island
export { default as ReexportedRoot } from "../../apps/web/src/components/tanstack-devtools-root";

export const StaticDevtoolsImportFixture = ({
  panel,
}: {
  panel: typeof ReactQueryDevtoolsPanel;
}) => (
  <>
    <TanStackDevtools plugins={[]} />
    <LazyTanStackDevtoolsRoot sourceInspector={false} />
    <TableDevtools table={panel} />
  </>
);

export { pendingQueryDevtools, routerDevtools };
