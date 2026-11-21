import { createFileRoute } from "@tanstack/react-router";

import { styleSetsOptions } from "@/features/style-sets/style-set-queries";
import { getAnalytics } from "@/lib/analytics/provider";
import { detached } from "@/lib/detached";
import { pageTitle } from "@/lib/page-title";
import { prefetchRouteQuery } from "@/lib/react-query";
import { routePresentation } from "@/routes/-route-presentation";
import { StyleSetsPage } from "@/routes/knowledge/-member/styles.page";
import { StyleSetsPending } from "@/routes/knowledge/-member/styles.pending";

export const Route = createFileRoute("/knowledge/styles")({
  loader: ({ context }) => {
    // Readable without an account: nothing is loaded before the section
    // knows who is visiting.
    if (context.user === undefined) {
      return;
    }
    const organizationId = context.user.activeOrganizationId;
    const onPrefetchError = (error: unknown) => {
      getAnalytics().captureError(error, {
        fingerprintKey: "knowledge.styles.loader.onPrefetchError:failure",
        scope: {
          type: "request",
          method: "GET",
          routeTemplate: "/knowledge/styles",
        },
      });
    };

    detached(
      prefetchRouteQuery(
        context.queryClient,
        styleSetsOptions(organizationId),
        onPrefetchError,
      ),
      "knowledge-styles.prefetch",
    );
  },
  staticData: {
    presentation: routePresentation({
      type: "label",
      labelKey: "styleSets.title",
      to: "/knowledge/styles",
    }),
  },
  head: () => ({ meta: [{ title: pageTitle("styleSets.title") }] }),
  component: StyleSetsPage,
  pendingComponent: StyleSetsPending,
});
