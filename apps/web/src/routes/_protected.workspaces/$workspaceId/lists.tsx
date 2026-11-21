import { createFileRoute, notFound } from "@tanstack/react-router";
import * as v from "valibot";

import { loadCallerFeature } from "@/lib/organization/feature-access/access";
import { CALLER_FEATURE } from "@/lib/organization/feature-access/surfaces";
import { ensureRouteQueryData } from "@/lib/react-query";
import { legalListsOptions } from "@/lib/workspaces/queries/legal-lists";
import { routeSearchSchema } from "@/route-search-params";

import { ListsRoutePage } from "./-lists.page";
import { ListsPending } from "./-lists.pending";

const searchSchema = routeSearchSchema({
  list: v.optional(v.string()),
});

export const Route = createFileRoute(
  "/_protected/workspaces/$workspaceId/lists",
)({
  validateSearch: searchSchema,
  loader: async ({ context, params }) => {
    const admission = await loadCallerFeature({
      queryClient: context.queryClient,
      principal: {
        organizationId: context.user.activeOrganizationId,
        userId: context.user.id,
      },
      feature: CALLER_FEATURE.legalLists,
      load: async () => {
        await ensureRouteQueryData(
          context.queryClient,
          legalListsOptions(params.workspaceId),
        );
      },
    });
    if (admission.isErr()) {
      notFound({ throw: true });
    }
  },
  remountDeps: ({ params }) => params.workspaceId,
  component: ListsRoutePage,
  pendingComponent: ListsPending,
});
