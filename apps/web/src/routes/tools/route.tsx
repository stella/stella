import { createFileRoute, notFound } from "@tanstack/react-router";

import { legacyToolsRoutesServed } from "@/lib/knowledge/public-tools-path";
import {
  APP_FRAME_SCOPE,
  MEMBER_PROVIDER_SCOPES,
} from "@/routes/-app-frame-scope";
import { PublicToolsShell } from "@/routes/tools/-components/public-tools-shell";

// The older top-level tools pages. They answer only while Knowledge needs an
// account, and go once the Knowledge flag is permanent.
export const Route = createFileRoute("/tools")({
  staticData: {
    appFrame: APP_FRAME_SCOPE.none,
    providerScopes: MEMBER_PROVIDER_SCOPES,
  },
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
