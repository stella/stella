import { createFileRoute } from "@tanstack/react-router";

import { PUBLIC_DECISION_MATCH } from "@/features/case-law/public-decision-match";
import { PublicDecisionViewer } from "@/routes/law/-case-detail";
import { publicDecisionSearchSchema } from "@/routes/law/-case-detail.logic";
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
  const fileMayHoldOthers = Route.useSearch({
    select: (search) => search.match === PUBLIC_DECISION_MATCH.FILE_INCOMPLETE,
  });

  return (
    <PublicDecisionViewer
      decision={decision}
      fileMayHoldOthers={fileMayHoldOthers}
      initialSearchQuery={initialSearchQuery}
      routeId={Route.id}
    />
  );
}
