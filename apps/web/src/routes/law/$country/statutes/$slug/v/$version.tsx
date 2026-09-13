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
 * names the latest text, redirects to the address that text is canonical at.
 */
export const Route = createFileRoute("/law/$country/statutes/$slug/v/$version")(
  {
    validateSearch: publicStatuteSearchSchema,
    loaderDeps: ({ search: { asOf, jump } }) => ({ asOf, jump }),
    loader: async ({ context: { queryClient }, deps, params }) =>
      await loadPublicStatuteRoute({ params, queryClient, search: deps }),
    head: ({ loaderData }) =>
      loaderData ? createPublicStatuteHead(loaderData) : { meta: [] },
    component: PublicStatuteVersionRoute,
  },
);

function PublicStatuteVersionRoute() {
  const { statute, work } = Route.useLoaderData();
  const requestedJump = Route.useSearch({ select: (search) => search.jump });

  return (
    <PublicStatuteViewer
      asOf={undefined}
      requestedJump={requestedJump}
      statute={statute}
      work={work}
    />
  );
}
