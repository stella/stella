import { createFileRoute, notFound } from "@tanstack/react-router";

import "@/features/case-law/case-decision-details-inspector-registration";
import "@/features/case-law/case-decision-inspector-registration";
import "@/features/statutes/provision-inspector-registration";
import { isPublicLawRouteEnabled } from "@/lib/public-law-launch";
import { PublicLawShell } from "@/routes/law/-components/public-law-shell";

export const Route = createFileRoute("/law")({
  beforeLoad: () => {
    if (!isPublicLawRouteEnabled()) {
      throw notFound();
    }
  },
  component: LawRouteComponent,
});

function LawRouteComponent() {
  return <PublicLawShell />;
}
