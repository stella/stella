import { createFileRoute, Outlet } from "@tanstack/react-router";

import { DefaultPendingComponent } from "@/components/route-components";
import { isPublicKnowledgeEnabled } from "@/lib/knowledge/public-knowledge-launch";
import { pageTitle } from "@/lib/page-title";
import {
  loadProtectedContext,
  prefetchProtectedShell,
} from "@/routes/-protected-guard";

// Knowledge sits beside the signed-in routes rather than under them, so it can
// be readable without an account. Until that is switched on it keeps exactly
// their guard: no session sends the visitor to sign in, no organization to
// pick one, and nothing renders on the server. Once it is on, the layout does
// no data work at all; each section picks what to show after the session is
// known, and the root picks the frame the same way.
const guarded = !isPublicKnowledgeEnabled();

export const Route = createFileRoute("/knowledge")({
  // Off behind sign-in; otherwise the root's public-path rule decides, since
  // a route cannot render on the server where its parent does not.
  ssr: !guarded,
  beforeLoad: async (args) =>
    guarded ? await loadProtectedContext(args) : { user: undefined },
  loader: async (args) => {
    if (guarded) {
      await prefetchProtectedShell(args);
    }
  },
  head: () => ({
    meta: [{ title: pageTitle("navigation.knowledge") }],
  }),
  component: KnowledgeLayout,
  pendingComponent: DefaultPendingComponent,
});

function KnowledgeLayout() {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Outlet />
    </div>
  );
}
