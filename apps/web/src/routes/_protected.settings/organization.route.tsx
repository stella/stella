import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import * as v from "valibot";

import { ensureCriticalQueryData } from "@/lib/react-query";
import { optionalSearchStringSchema } from "@/lib/schema";
import { roleOptions } from "@/routes/-queries";
import { managementRoles } from "@/routes/_protected.organization/-consts";

const searchSchema = v.strictObject({
  q: optionalSearchStringSchema(),
});

export const Route = createFileRoute("/_protected/settings/organization")({
  validateSearch: searchSchema,
  beforeLoad: async ({ context }) => {
    const role = await ensureCriticalQueryData(
      context.queryClient,
      roleOptions,
    );

    if (!managementRoles.includes(role)) {
      throw redirect({ to: "/settings/account/profile", replace: true });
    }
  },
  component: OrganizationSettingsLayout,
});

function OrganizationSettingsLayout() {
  return <Outlet />;
}
