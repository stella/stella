import { createFileRoute, Outlet } from "@tanstack/react-router";

import { APP_FRAME_SCOPE } from "@/routes/-app-frame-scope";
import { loadAuthContext } from "@/routes/-auth-context";
import { LeafPendingView } from "@/routes/-route-pending-view";

export const Route = createFileRoute("/auth")({
  staticData: { appFrame: APP_FRAME_SCOPE.auth },
  // Signed OAuth state arrives in the URL fragment, which HTTP omits.
  ssr: false,
  beforeLoad: async ({ context }) => await loadAuthContext(context.queryClient),
  component: () => <Outlet />,
  pendingComponent: LeafPendingView,
});
