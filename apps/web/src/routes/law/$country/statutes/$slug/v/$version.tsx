import { createFileRoute } from "@tanstack/react-router";

import { PublicStatuteViewer } from "@/routes/law/-statute-detail";
import {
  createPublicStatuteHead,
  loadPublicStatuteRoute,
  publicStatuteSearchSchema,
} from "@/routes/law/-statute-detail.logic";

/**
 * One consolidation of a statute, addressed by the day its validity window
 * opened. A request that names a day no consolidation opened on, or one that
 * names the text the bare address shows, redirects to the address that text is canonical at.
 */
export const Route = createFileRoute("/law/$country/statutes/$slug/v/$version")(
  {
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
    component: PublicStatuteVersionRoute,
  },
);

function PublicStatuteVersionRoute() {
  const { statute, versions, work } = Route.useLoaderData();
  const requestedJump = Route.useSearch({ select: (search) => search.jump });

  return (
    <PublicStatuteViewer
      asOf={undefined}
      requestedJump={requestedJump}
      statute={statute}
      versions={versions}
      work={work}
    />
  );
}
