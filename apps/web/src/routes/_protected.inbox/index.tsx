import { createFileRoute, redirect } from "@tanstack/react-router";

import "@/features/inbox/signal-inspector-registration";
import { isInboxPreviewEnabled } from "@/hooks/use-inbox-preview";
import { pageTitle } from "@/lib/page-title";
import { ensureRouteQueryData } from "@/lib/react-query";
import { entityViewsOptions } from "@/lib/workspaces/queries/entity-views";
import { routePresentation } from "@/routes/-route-presentation";

import { InboxPage } from "./-inbox.page";
import { InboxPending } from "./-inbox.pending";

export const Route = createFileRoute("/_protected/inbox/")({
  staticData: {
    presentation: routePresentation({
      type: "label",
      labelKey: "navigation.inbox",
      to: "/inbox",
    }),
  },
  beforeLoad: () => {
    if (!import.meta.env.DEV && !isInboxPreviewEnabled()) {
      throw redirect({ to: "/chat" });
    }
  },
  loader: async ({ context }) => {
    await ensureRouteQueryData(
      context.queryClient,
      entityViewsOptions(context.user.activeOrganizationId, context.user.id),
    );
  },
  head: () => ({ meta: [{ title: pageTitle("navigation.inbox") }] }),
  pendingComponent: InboxPending,
  component: InboxPage,
});
