import { createFileRoute, notFound, Outlet } from "@tanstack/react-router";

import { isPublicLawEnabled } from "@/lib/public-law-launch";
import "@/features/case-law/case-decision-details-inspector-registration";
import "@/features/case-law/case-decision-inspector-registration";
import "@/features/statutes/provision-inspector-registration";
import "@/features/statutes/statute-inspector-registration";
import {
  APP_FRAME_SCOPE,
  MEMBER_PROVIDER_SCOPES,
} from "@/routes/-app-frame-scope";
import { LeafPendingView } from "@/routes/-route-pending-view";
import { PublicLawShell } from "@/routes/law/-components/public-law-shell";

export const Route = createFileRoute("/law")({
  staticData: {
    appFrame: APP_FRAME_SCOPE.none,
    providerScopes: MEMBER_PROVIDER_SCOPES,
  },
  beforeLoad: () => {
    if (!isPublicLawEnabled()) {
      throw notFound();
    }
  },
  component: LawRouteComponent,
  // A page's loading view is its own (the readers, the lists), drawn inside
  // the shell while the shell stays; only a load of the shell itself shows
  // the page's view alone.
  pendingComponent: LeafPendingView,
});

function LawRouteComponent() {
  return <PublicLawShell content={<Outlet />} />;
}
