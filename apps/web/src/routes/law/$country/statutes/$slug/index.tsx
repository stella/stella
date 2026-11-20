import { createFileRoute } from "@tanstack/react-router";

import { publicStatuteSearchSchema } from "@/features/statutes/statute-page-search";
import {
  createPublicStatuteHead,
  loadPublicStatuteRoute,
} from "@/routes/law/-statute-detail.logic";
import { PublicStatutePage } from "@/routes/law/-statute-detail.page";
import { StatuteReaderPending } from "@/routes/law/-statute-detail.pending";

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
  component: PublicStatutePage,
  pendingComponent: StatuteReaderPending,
});
