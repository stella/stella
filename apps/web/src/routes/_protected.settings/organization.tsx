import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";

import { isTimeBillingRouteEnabled } from "@/hooks/use-time-billing-preview";
import { getAnalytics } from "@/lib/analytics/provider";
import { roleOptions } from "@/lib/auth-queries";
import { detached } from "@/lib/detached";
import { hasOrganizationManagementAccess } from "@/lib/organization/role-assignment.logic";
import { pageTitle } from "@/lib/page-title";
import { ensureRouteQueryData, prefetchRouteQuery } from "@/lib/react-query";
import { organizationSettingsOptions } from "@/queries/organization-settings";
import { organizationSettingsSearchSchema } from "@/routes/-organization-settings-route";
import { routePresentation } from "@/routes/-route-presentation";

export const Route = createFileRoute("/_protected/settings/organization")({
  staticData: {
    presentation: routePresentation({
      type: "label",
      labelKey: "common.organization",
      to: "/settings/organization",
    }),
  },
  validateSearch: organizationSettingsSearchSchema,
  beforeLoad: async ({ context, location, matches }) => {
    // These routes already require enrolment before commit. Its read is
    // independent of the member role, so start both admission queries together.
    const rolePromise = ensureRouteQueryData(context.queryClient, roleOptions);
    const timeBillingPromise = (async () => {
      if (
        !matches.some(
          ({ staticData }) =>
            staticData.organizationSettingsAdmission === "time-billing",
        )
      ) {
        return undefined;
      }
      return await isTimeBillingRouteEnabled(context.queryClient, {
        userId: context.user.id,
        organizationId: context.user.activeOrganizationId,
      });
    })();
    // Observe failures even when the role redirects before this read settles.
    detached(
      timeBillingPromise.then(() => undefined),
      "organization-settings.admission",
    );
    const role = await rolePromise;

    if (!hasOrganizationManagementAccess(role)) {
      redirect({ to: "/settings/account/profile", replace: true, throw: true });
    }

    if ((await timeBillingPromise) === false) {
      redirect({
        to: "/settings/organization/members",
        replace: true,
        throw: true,
      });
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
            (error) =>
              getAnalytics().captureError(error, {
                fingerprintKey: "admin.route.beforeLoad:failure",
                scope: {
                  type: "request",
                  method: "GET",
                  routeTemplate: "/_protected/settings/organization",
                },
              }),
          );
        })(),
        "organization-settings.time-policy-prefetch",
      );
    }
  },
  head: () => ({ meta: [{ title: pageTitle("common.settings") }] }),
  component: OrganizationSettingsLayout,
});

function OrganizationSettingsLayout() {
  return <Outlet />;
}
