import { createFileRoute, getRouteApi, redirect } from "@tanstack/react-router";

import "@/features/inbox/signal-inspector-registration";
import {
  EntityViews,
  EntityViewsPending,
} from "@/components/entity-views/entity-views";
import { isInboxPreviewEnabled } from "@/hooks/use-inbox-preview";
import { pageTitle } from "@/lib/page-title";
import { ensureRouteQueryData } from "@/lib/react-query";
import { entityViewsOptions } from "@/lib/workspaces/queries/entity-views";

const protectedRouteApi = getRouteApi("/_protected");

export const Route = createFileRoute("/_protected/inbox/")({
  beforeLoad: async ({ context }) => {
    if (
      !(await isInboxPreviewEnabled(context.queryClient, {
        userId: context.user.id,
        organizationId: context.user.activeOrganizationId,
      }))
    ) {
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
