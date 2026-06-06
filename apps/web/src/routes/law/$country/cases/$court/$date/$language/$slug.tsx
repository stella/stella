import { createFileRoute } from "@tanstack/react-router";

import {
  createPublicCaseLawDecisionHead,
  loadPublicCaseLawDecisionRoute,
  PublicDecisionViewer,
  publicDecisionSearchSchema,
} from "@/routes/law/-case-detail";

export const Route = createFileRoute(
  "/law/$country/cases/$court/$date/$language/$slug",
)({
  validateSearch: publicDecisionSearchSchema,
  loaderDeps: ({ search }) => search,
  loader: async ({ context: { queryClient }, deps, params }) =>
    await loadPublicCaseLawDecisionRoute({
      params,
      queryClient,
      search: deps,
    }),
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
  const initialSearchQuery = Route.useSearch({ select: (search) => search.q });

  return (
    <PublicDecisionViewer
      decision={decision}
      initialSearchQuery={initialSearchQuery}
      params={params}
    />
  );
}
