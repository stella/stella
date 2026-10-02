import { createFileRoute } from "@tanstack/react-router";

import { PublicDecisionViewer } from "@/routes/law/-case-detail";
import {
  fileMayHoldOthersOf,
  publicDecisionSearchSchema,
} from "@/routes/law/-case-detail.logic";
import {
  loadPublicDecisionRoute,
  publicDecisionHead,
} from "@/routes/law/-public-decision-route";

export const Route = createFileRoute(
  "/law/$country/cases/$court/$language/$slug",
)({
  validateSearch: publicDecisionSearchSchema,
  loaderDeps: ({ search }) => search,
  loader: loadPublicDecisionRoute,
  head: publicDecisionHead,
  component: PublicDecisionRoute,
});

function PublicDecisionRoute() {
  const decision = Route.useLoaderData();
  const initialSearchQuery = Route.useSearch({ select: (search) => search.q });
  const fileMayHoldOthers = Route.useSearch({ select: fileMayHoldOthersOf });

  return (
    <PublicDecisionViewer
      decision={decision}
      fileMayHoldOthers={fileMayHoldOthers}
      initialSearchQuery={initialSearchQuery}
      routeId={Route.id}
    />
  );
}
