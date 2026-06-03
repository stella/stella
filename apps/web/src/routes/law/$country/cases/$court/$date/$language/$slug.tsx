import { createFileRoute } from "@tanstack/react-router";

import {
  createPublicCaseLawDecisionHead,
  loadPublicCaseLawDecisionRoute,
  PublicDecisionViewer,
} from "@/routes/law/-case-detail";

export const Route = createFileRoute(
  "/law/$country/cases/$court/$date/$language/$slug",
)({
  loader: async ({ context: { queryClient }, params }) =>
    await loadPublicCaseLawDecisionRoute({ params, queryClient }),
  head: ({ loaderData, params }) => {
    if (!loaderData?.caseNumber) {
      return { meta: [] };
    }

    return createPublicCaseLawDecisionHead({
      decision: loaderData,
      params,
    });
  },
  component: PublicDecisionRoute,
});

function PublicDecisionRoute() {
  const params = Route.useParams({
    select: ({ country, court, date, language, slug }) => ({
      country,
      court,
      date,
      language,
      slug,
    }),
  });
  const decision = Route.useLoaderData();

  return <PublicDecisionViewer decision={decision} params={params} />;
}
