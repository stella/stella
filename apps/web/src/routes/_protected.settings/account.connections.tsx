import { createFileRoute } from "@tanstack/react-router";

import { browserSiteGrantsOptions } from "@/features/chat/browser-control/browser-site-grants";
import { prefetchSharepointAccess } from "@/features/sharepoint/sharepoint-queries";
import {
  mcpConnectionsOptions,
  mcpConnectorsOptions,
} from "@/lib/knowledge/queries";
import { catalogueOptions } from "@/lib/knowledge/queries/catalogue";
import { ensureRouteQueryData } from "@/lib/react-query";
import { connectedAppsOptions } from "@/routes/_protected.settings/-queries/connections";

import { ConnectionsPage } from "./-account.connections.page";
import { ConnectionsPending } from "./-account.connections.pending";

export const Route = createFileRoute(
  "/_protected/settings/account/connections",
)({
  component: ConnectionsPage,
  loader: async ({ context }) => {
    // Prime every query the page suspends on so the fetches run in parallel
    // during navigation instead of one after another on mount.
    const organizationId = context.user.activeOrganizationId;
    prefetchSharepointAccess({
      queryClient: context.queryClient,
      viewer: { organizationId, userId: context.user.id },
      routeTemplate: "/_protected/settings/account/connections",
    });
    await Promise.all([
      ensureRouteQueryData(
        context.queryClient,
        connectedAppsOptions(context.user.id),
      ),
      ensureRouteQueryData(
        context.queryClient,
        catalogueOptions(organizationId, context.user.id),
      ),
      ensureRouteQueryData(
        context.queryClient,
        mcpConnectionsOptions(organizationId, context.user.id),
      ),
      ensureRouteQueryData(
        context.queryClient,
        mcpConnectorsOptions(organizationId),
      ),
      ensureRouteQueryData(
        context.queryClient,
        browserSiteGrantsOptions({
          activeOrganizationId: organizationId,
          userId: context.user.id,
        }),
      ),
    ]);
  },
  pendingComponent: ConnectionsPending,
});
