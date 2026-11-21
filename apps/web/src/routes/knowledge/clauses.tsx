import { createFileRoute } from "@tanstack/react-router";

import { getAnalytics } from "@/lib/analytics/provider";
import { detached } from "@/lib/detached";
import {
  clauseCategoriesOptions,
  clausesOptions,
} from "@/lib/knowledge/queries";
import { pageTitle } from "@/lib/page-title";
import { prefetchRouteQuery } from "@/lib/react-query";
import { routePresentation } from "@/routes/-route-presentation";
import { ClausesPage } from "@/routes/knowledge/-member/clauses.page";
import { ClausesPending } from "@/routes/knowledge/-member/clauses.pending";

export const Route = createFileRoute("/knowledge/clauses")({
  loader: ({ context }) => {
    // Readable without an account: nothing is loaded before the section
    // knows who is visiting.
    if (context.user === undefined) {
      return;
    }
    const organizationId = context.user.activeOrganizationId;
    const onPrefetchError = (error: unknown) => {
      getAnalytics().captureError(error, {
        fingerprintKey: "knowledge.clauses.loader.onPrefetchError:failure",
        scope: {
          type: "request",
          method: "GET",
          routeTemplate: "/knowledge/clauses",
        },
      });
    };

    detached(
      Promise.all([
        prefetchRouteQuery(
          context.queryClient,
          clauseCategoriesOptions(organizationId),
          onPrefetchError,
        ),
        prefetchRouteQuery(
          context.queryClient,
          clausesOptions(organizationId, { categoryId: null, search: "" }),
          onPrefetchError,
        ),
      ]),
      "knowledge-clauses.prefetch",
    );
  },
  staticData: {
    presentation: routePresentation({
      type: "knowledge-detail",
      detail: "clauses",
    }),
  },
  head: () => ({ meta: [{ title: pageTitle("common.clauses") }] }),
  component: ClausesPage,
  pendingComponent: ClausesPending,
});
