import { createFileRoute } from "@tanstack/react-router";

import { DefaultPendingComponent } from "@/components/route-components";
import {
  APP_FRAME_SCOPE,
  MEMBER_PROVIDER_SCOPES,
} from "@/routes/-app-frame-scope";
import {
  loadProtectedContext,
  prefetchProtectedShell,
} from "@/routes/-protected-guard";

// The signed-in frame itself renders from the root (`AppFrameHost`), above
// this guard, so it stays mounted across every signed-in route.
export const Route = createFileRoute("/_protected")({
  staticData: {
    appFrame: APP_FRAME_SCOPE.member,
    providerScopes: MEMBER_PROVIDER_SCOPES,
  },
  ssr: false,
  beforeLoad: loadProtectedContext,
  loader: prefetchProtectedShell,
  // Static content only: AppFrameHost owns the first-load and mounted shell.
  pendingComponent: DefaultPendingComponent,
});
