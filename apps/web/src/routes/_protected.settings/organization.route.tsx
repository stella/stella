import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import * as v from "valibot";

import { isTimeBillingRouteEnabled } from "@/hooks/use-time-billing-preview";
import { getAnalytics } from "@/lib/analytics/provider";
import { roleOptions } from "@/lib/auth-queries";
import { detached } from "@/lib/detached";
import { hasOrganizationManagementAccess } from "@/lib/organization/role-assignment.logic";
import { ensureRouteQueryData, prefetchRouteQuery } from "@/lib/react-query";
import { optionalSearchStringSchema } from "@/lib/schema";
import { organizationSettingsOptions } from "@/queries/organization-settings";

const searchSchema = v.strictObject({
  q: optionalSearchStringSchema(),
});

export const Route = createFileRoute("/_protected/settings/organization")({
  validateSearch: searchSchema,
  beforeLoad: async ({ context, location }) => {
    const role = await ensureRouteQueryData(context.queryClient, roleOptions);

    if (!hasOrganizationManagementAccess(role)) {
      throw redirect({ to: "/settings/account/profile", replace: true });
    }

    // Start the time-policy query before its child route chunk and loader,
    // alongside shell data; the child loader still owns critical error handling.
    if (location.pathname === "/settings/organization/time-policy") {
      detached(
        (async () => {
          if (
            !(await isTimeBillingRouteEnabled(context.queryClient, {
              userId: context.user.id,
              organizationId: context.user.activeOrganizationId,
            }))
          ) {
            return;
          }
          await prefetchRouteQuery(
            context.queryClient,
            organizationSettingsOptions({
              organizationId: context.user.activeOrganizationId,
              userId: context.user.id,
            }),
            (error) => getAnalytics().captureError(error),
          );
        })(),
        "organization-settings.time-policy-prefetch",
      );
    }
  },
  component: OrganizationSettingsLayout,
});

function OrganizationSettingsLayout() {
  return <Outlet />;
}
