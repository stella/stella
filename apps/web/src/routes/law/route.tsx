import { createFileRoute, notFound } from "@tanstack/react-router";

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
