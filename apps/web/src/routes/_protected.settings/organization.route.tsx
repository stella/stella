import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import * as v from "valibot";

import { isOrganizationManagementRole } from "@stll/permissions";

import { roleOptions } from "@/lib/auth-queries";
import { ensureRouteQueryData } from "@/lib/react-query";
import { optionalSearchStringSchema } from "@/lib/schema";

const searchSchema = v.strictObject({
  q: optionalSearchStringSchema(),
});

export const Route = createFileRoute("/_protected/settings/organization")({
  validateSearch: searchSchema,
  beforeLoad: async ({ context }) => {
    const role = await ensureRouteQueryData(context.queryClient, roleOptions);

    if (!isOrganizationManagementRole(role)) {
      throw redirect({ to: "/settings/account/profile", replace: true });
    }
  },
  component: OrganizationSettingsLayout,
});

function OrganizationSettingsLayout() {
  return <Outlet />;
}
