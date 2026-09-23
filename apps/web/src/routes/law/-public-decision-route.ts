import type { QueryClient } from "@tanstack/react-query";

import {
  createPublicCaseLawDecisionHead,
  loadPublicCaseLawDecisionRoute,
} from "@/routes/law/-case-detail.logic";
import type {
  PublicCaseLawDecision,
  PublicDecisionRouteParams,
  PublicDecisionSearch,
} from "@/routes/law/-case-detail.logic";

// Loader and head shared by the decision routes with and without a language
// segment; each route file keeps its own `createFileRoute` call so route
// generation still sees it.

type PublicDecisionLoaderContext = {
  context: { queryClient: QueryClient };
  deps: PublicDecisionSearch;
  location: { hash: string };
  params: PublicDecisionRouteParams;
};

export const loadPublicDecisionRoute = async ({
  context: { queryClient },
  deps,
  location,
  params,
}: PublicDecisionLoaderContext) =>
  await loadPublicCaseLawDecisionRoute({
    hash: location.hash,
    params,
    queryClient,
    search: deps,
  });

type PublicDecisionHeadContext = {
  loaderData?: PublicCaseLawDecision | undefined;
  params: PublicDecisionRouteParams;
};

export const publicDecisionHead = ({
  loaderData,
  params,
}: PublicDecisionHeadContext) => {
  if (!loaderData?.caseNumber) {
    return { meta: [] };
  }

  return createPublicCaseLawDecisionHead({
    decision: loaderData,
    params,
  });
};
