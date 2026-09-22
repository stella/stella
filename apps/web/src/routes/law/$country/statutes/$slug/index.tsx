import { createFileRoute } from "@tanstack/react-router";

import { PublicStatuteViewer } from "@/routes/law/-statute-detail";
import {
  createPublicStatuteHead,
  loadPublicStatuteRoute,
  publicStatuteSearchSchema,
} from "@/routes/law/-statute-detail.logic";

/**
 * A statute at its canonical address: the readable segment alone, which
 * names the version in force today (the latest one when none is). The same route answers the legacy
 * document-id form and redirects it here.
 */
export const Route = createFileRoute("/law/$country/statutes/$slug/")({
  validateSearch: publicStatuteSearchSchema,
  // The whole search, not a pick: a canonical redirect re-issues it, and a
  // parameter left out here would be dropped on the way.
  loaderDeps: ({ search }) => search,
  loader: async ({ context: { queryClient }, deps, location, params }) =>
    await loadPublicStatuteRoute({
      hash: location.hash,
      params,
      queryClient,
      search: deps,
    }),
  head: ({ loaderData }) =>
    loaderData ? createPublicStatuteHead(loaderData) : { meta: [] },
  component: PublicStatuteRoute,
});

function PublicStatuteRoute() {
  const { statute, versions, work } = Route.useLoaderData();
  const asOf = Route.useSearch({ select: (search) => search.asOf });
  const requestedJump = Route.useSearch({ select: (search) => search.jump });

  return (
    <PublicStatuteViewer
      asOf={asOf}
      requestedJump={requestedJump}
      statute={statute}
      versions={versions}
      work={work}
    />
  );
}
