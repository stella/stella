import { createFileRoute, notFound } from "@tanstack/react-router";

import { legacyToolsRoutesServed } from "@/lib/knowledge/public-tools-path";
import { PublicToolsShell } from "@/routes/tools/-components/public-tools-shell";

// The older top-level tools pages. They answer only while Knowledge needs an
// account, and go once the Knowledge flag is permanent.
export const Route = createFileRoute("/tools")({
  beforeLoad: () => {
    if (!legacyToolsRoutesServed()) {
      throw notFound();
    }
  },
  component: ToolsRouteComponent,
});

function ToolsRouteComponent() {
  return <PublicToolsShell />;
}
