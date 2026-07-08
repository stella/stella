// Passive regression fixture for
// `require-loader-prefetch/require-loader-prefetch`.
//
// Route file with NO loader that imports a colocated component
// (`-components/require-loader-prefetch-child.fixture.tsx`) whose
// `useSuspenseQuery(childEntityOptions(...))` call is invisible to a
// single-file AST check. The cross-file, one-hop resolution must still flag
// it: the route has no `loader` to prefetch the query the child suspends on.

import { createFileRoute } from "@tanstack/react-router";

// oxlint-disable-next-line require-loader-prefetch/require-loader-prefetch
import { ChildComponent } from "@/routes/-components/require-loader-prefetch-child.fixture";

export const Route = createFileRoute("/__fixture/child-missing-loader")({
  component: ChildMissingLoaderComponent,
});

function ChildMissingLoaderComponent() {
  return <ChildComponent />;
}
