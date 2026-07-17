import { createFileRoute, notFound } from "@tanstack/react-router";

import { isPublicToolsRouteEnabled } from "@/lib/public-tools-launch";
import { PublicToolsShell } from "@/routes/tools/-components/public-tools-shell";

export const Route = createFileRoute("/tools")({
  beforeLoad: () => {
    if (!isPublicToolsRouteEnabled()) {
      throw notFound();
    }
  },
  component: ToolsRouteComponent,
});

function ToolsRouteComponent() {
  return <PublicToolsShell />;
}
