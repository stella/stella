import { createFileRoute } from "@tanstack/react-router";

import { PublicDecisionViewer } from "@/routes/law/-case-detail";
import { publicDecisionSearchSchema } from "@/routes/law/-case-detail.logic";
import {
  loadPublicDecisionRoute,
  publicDecisionHead,
} from "@/routes/law/-public-decision-route";

export const Route = createFileRoute("/law/$country/cases/$court/$slug")({
  validateSearch: publicDecisionSearchSchema,
  loaderDeps: ({ search }) => search,
  loader: loadPublicDecisionRoute,
  head: publicDecisionHead,
  component: PublicDecisionRoute,
});

function PublicDecisionRoute() {
  const decision = Route.useLoaderData();
  const initialSearchQuery = Route.useSearch({ select: (search) => search.q });

  return (
    <PublicDecisionViewer
      decision={decision}
      initialSearchQuery={initialSearchQuery}
      routeId={Route.id}
    />
  );
}
