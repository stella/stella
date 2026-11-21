import { createFileRoute } from "@tanstack/react-router";

import { prefetchSharepointAccess } from "@/features/sharepoint/sharepoint-queries";
import { mcpConnectorsOptions } from "@/lib/knowledge/queries";
import { pageTitle } from "@/lib/page-title";
import { ensureRouteQueryData } from "@/lib/react-query";
import { routePresentation } from "@/routes/-route-presentation";

import { OrganizationToolsPage } from "./-organization.tools.page";
import { ToolsPending } from "./-organization.tools.pending";

export const Route = createFileRoute("/_protected/settings/organization/tools")(
  {
    staticData: {
      presentation: routePresentation({
        type: "label",
        labelKey: "knowledge.sections.tools.title",
        to: "/settings/organization/tools",
      }),
    },
    loader: async ({ context }) => {
      prefetchSharepointAccess({
        queryClient: context.queryClient,
        viewer: {
          organizationId: context.user.activeOrganizationId,
          userId: context.user.id,
        },
        routeTemplate: "/_protected/settings/organization/tools",
      });
      await ensureRouteQueryData(
        context.queryClient,
        mcpConnectorsOptions(context.user.activeOrganizationId),
      );
    },
    head: () => ({
      meta: [{ title: pageTitle("knowledge.sections.tools.title") }],
    }),
    component: OrganizationToolsPage,
    pendingComponent: ToolsPending,
  },
);
