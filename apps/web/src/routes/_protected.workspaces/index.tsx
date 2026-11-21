import { createFileRoute, stripSearchParams } from "@tanstack/react-router";
import * as v from "valibot";

import {
  VISIBLE_WORKSPACE_STATUSES,
  WORKSPACE_STATUS,
} from "@stll/api-contract/workspace-status";

import { pageTitle } from "@/lib/page-title";
import { ensureRouteQueryData } from "@/lib/react-query";
import { workspacesRouteOptions } from "@/lib/workspaces/queries";
import { routeSearchSchema } from "@/route-search-params";
import { routePresentation } from "@/routes/-route-presentation";

import { MattersPage } from "./-matters.page";
import { MattersPending } from "./-matters.pending";

const searchSchema = routeSearchSchema({
  status: v.optional(
    v.picklist(VISIBLE_WORKSPACE_STATUSES),
    WORKSPACE_STATUS.active,
  ),
  // Client id to scroll into view and flash on arrival (set by the matter
  // breadcrumb's company link). Cleared by the route once consumed.
  focusClient: v.optional(v.string()),
});

export const Route = createFileRoute("/_protected/workspaces/")({
  staticData: { presentation: routePresentation({ type: "inherit" }) },
  validateSearch: searchSchema,
  // Active is the default view, so `/workspaces` stays the canonical address.
  search: {
    middlewares: [stripSearchParams({ status: WORKSPACE_STATUS.active })],
  },
  loaderDeps: ({ search }) => ({ status: search.status }),
  loader: async ({ context, deps }) => {
    // Prime the workspaces query the page suspends on so the fetch starts
    // during navigation instead of after the component mounts and suspends.
    await ensureRouteQueryData(
      context.queryClient,
      workspacesRouteOptions(context.user.activeOrganizationId, deps.status),
    );
  },
  head: () => ({
    meta: [{ title: pageTitle("common.matters") }],
  }),
  component: MattersPage,
  pendingComponent: MattersPending,
});
