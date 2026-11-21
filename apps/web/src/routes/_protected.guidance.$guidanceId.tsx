import { createFileRoute } from "@tanstack/react-router";

import { loadRouteResource } from "@/lib/errors/route-resource";
import { guidanceDocumentOptions } from "@/lib/legal/guidance-queries";
import { pageTitleLiteral } from "@/lib/page-title";
import { ensureRouteQueryData } from "@/lib/react-query";
import { routePresentation } from "@/routes/-route-presentation";

import { GuidanceReaderPage } from "./-guidance-reader.page";
import { GuidanceReaderPending } from "./-guidance-reader.pending";

export const Route = createFileRoute("/_protected/guidance/$guidanceId")({
  staticData: { presentation: routePresentation({ type: "none" }) },
  // An id that is not a served document lands on the shared not-found page.
  loader: async ({ context, params }) =>
    await loadRouteResource({
      ids: [params.guidanceId],
      load: async () =>
        await ensureRouteQueryData(
          context.queryClient,
          guidanceDocumentOptions(params.guidanceId),
        ),
    }),
  head: ({ loaderData }) => ({
    meta:
      loaderData === undefined
        ? []
        : [{ title: pageTitleLiteral(loaderData.title) }],
  }),
  pendingComponent: GuidanceReaderPending,
  component: GuidanceReaderPage,
});
