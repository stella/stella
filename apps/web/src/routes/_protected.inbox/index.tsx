import { createFileRoute, getRouteApi, redirect } from "@tanstack/react-router";

import "@/features/inbox/signal-inspector-registration";
import {
  EntityViews,
  EntityViewsPending,
} from "@/components/entity-views/entity-views";
import { isInboxPreviewEnabled } from "@/hooks/use-inbox-preview";
import { pageTitle } from "@/lib/page-title";
import { entityViewsOptions } from "@/lib/workspaces/queries/entity-views";

const protectedRouteApi = getRouteApi("/_protected");

export const Route = createFileRoute("/_protected/inbox/")({
  beforeLoad: () => {
    if (!import.meta.env.DEV && !isInboxPreviewEnabled()) {
      throw redirect({ to: "/chat" });
    }
  },
  loader: async ({ context }) => {
    await context.queryClient.ensureQueryData(
      entityViewsOptions(context.user.activeOrganizationId),
    );
  },
  head: () => ({ meta: [{ title: pageTitle("navigation.inbox") }] }),
  pendingComponent: EntityViewsPending,
  component: InboxPage,
});

function InboxPage() {
  const organizationId = protectedRouteApi.useRouteContext({
    select: (ctx) => ctx.user.activeOrganizationId,
  });
  return (
    <EntityViews
      key={organizationId}
      organizationId={organizationId}
      scope={{ type: "organization" }}
    />
  );
}
