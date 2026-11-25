import { createFileRoute } from "@tanstack/react-router";

import { browserSiteGrantsOptions } from "@/features/chat/browser-control/browser-site-grants";
import { browserSiteNotesOptions } from "@/features/chat/browser-control/browser-site-notes";
import { prefetchSharepointAccess } from "@/features/sharepoint/sharepoint-queries";
import {
  mcpConnectionsOptions,
  mcpConnectorsOptions,
} from "@/lib/knowledge/queries";
import { catalogueOptions } from "@/lib/knowledge/queries/catalogue";
import { pageTitle } from "@/lib/page-title";
import { ensureRouteQueryData } from "@/lib/react-query";
import { routePresentation } from "@/routes/-route-presentation";
import { connectedAppsOptions } from "@/routes/_protected.settings/-queries/connections";

import { ConnectionsPage } from "./-account.connections.page";
import { ConnectionsPending } from "./-account.connections.pending";

export const Route = createFileRoute(
  "/_protected/settings/account/connections",
)({
  staticData: {
    presentation: routePresentation({
      type: "label",
      labelKey: "settings.connections.title",
      to: "/settings/account/connections",
    }),
  },
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
      ensureRouteQueryData(
        context.queryClient,
        browserSiteNotesOptions({
          activeOrganizationId: organizationId,
          userId: context.user.id,
        }),
      ),
    ]);
  },
  component: ConnectionsPage,
  head: () => ({ meta: [{ title: pageTitle("settings.connections.title") }] }),
  pendingComponent: ConnectionsPending,
});
