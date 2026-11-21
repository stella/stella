import { createFileRoute, redirect } from "@tanstack/react-router";

import { workflowsRouteAvailable } from "@/hooks/use-workflows-preview";
import { pageTitle } from "@/lib/page-title";
import { routePresentation } from "@/routes/-route-presentation";
import { WorkflowsPage } from "@/routes/knowledge/-member/workflows.page";
import { WorkflowsPending } from "@/routes/knowledge/-member/workflows.pending";

export const Route = createFileRoute("/knowledge/workflows")({
  staticData: {
    presentation: routePresentation({
      type: "label",
      labelKey: "common.workflows",
      to: "/knowledge/workflows",
    }),
  },
  beforeLoad: () => {
    if (!workflowsRouteAvailable()) {
      throw redirect({ to: "/knowledge" });
    }
  },
  component: WorkflowsPage,
  pendingComponent: WorkflowsPending,
  head: () => ({ meta: [{ title: pageTitle("common.workflows") }] }),
});
