import { createFileRoute, redirect } from "@tanstack/react-router";
import * as v from "valibot";

import { workflowsRouteAvailable } from "@/hooks/use-workflows-preview";
import { routeSearchSchema } from "@/route-search-params";

import { WorkflowsPage } from "./-workflows.page";
import { WorkflowsPending } from "./-workflows.pending";

/**
 * `run` is the open run: the task a review gate raised and the notification
 * bell both land here with the run they are about, and the list, the launcher,
 * and the back button all move by changing it, so history and a later link
 * agree on what is shown.
 */
const workflowsSearchSchema = routeSearchSchema({
  run: v.optional(v.string()),
});

export const Route = createFileRoute(
  "/_protected/workspaces/$workspaceId/workflows",
)({
  validateSearch: workflowsSearchSchema,
  beforeLoad: ({ params }) => {
    if (!workflowsRouteAvailable()) {
      throw redirect({
        to: "/workspaces/$workspaceId",
        params: { workspaceId: params.workspaceId },
      });
    }
  },
  component: WorkflowsPage,
  pendingComponent: WorkflowsPending,
});
