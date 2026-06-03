import { createFileRoute } from "@tanstack/react-router";

import { PublicLawShell } from "@/routes/law/-components/public-law-shell";

export const Route = createFileRoute("/law")({
  component: LawRouteComponent,
});

function LawRouteComponent() {
  return <PublicLawShell />;
}
