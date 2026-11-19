import { createFileRoute } from "@tanstack/react-router";

import { roleOptions } from "@/lib/auth-queries";
import { organizationOptions } from "@/lib/organization/queries";
import { pageTitle } from "@/lib/page-title";
import { ensureRouteQueryData } from "@/lib/react-query";
import { routePresentation } from "@/routes/-route-presentation";

import { MembersPage } from "./-organization.members.page";
import { MembersPending } from "./-organization.members.pending";

export const Route = createFileRoute(
  "/_protected/settings/organization/members",
)({
  staticData: {
    presentation: routePresentation({
      type: "label",
      labelKey: "common.members",
      to: "/settings/organization/members",
    }),
  },
  loader: async ({ context }) => {
    // Prime the org + role queries the page suspends on so the fetch starts
    // during navigation instead of after the component mounts and suspends.
    await Promise.all([
      ensureRouteQueryData(
        context.queryClient,
        organizationOptions(context.user.activeOrganizationId),
      ),
      ensureRouteQueryData(context.queryClient, roleOptions),
    ]);
  },
  component: MembersPage,
  pendingComponent: MembersPending,
  head: () => ({ meta: [{ title: pageTitle("common.members") }] }),
});
