import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import * as v from "valibot";

import { pageTitle } from "@/lib/page-title";
import { ensureCriticalQueryData } from "@/lib/react-query";
import { optionalSearchStringSchema } from "@/lib/schema";
import { roleOptions } from "@/routes/-queries";
import { managementRoles } from "@/routes/_protected.organization/-consts";

const searchSchema = v.strictObject({
  q: optionalSearchStringSchema(),
});

export const Route = createFileRoute("/_protected/organization")({
  validateSearch: searchSchema,
  beforeLoad: async ({ context }) => {
    const role = await ensureCriticalQueryData(
      context.queryClient,
      roleOptions,
    );

    if (!managementRoles.includes(role)) {
      throw redirect({ to: "/workspaces", replace: true });
    }
  },
  head: () => ({
    meta: [{ title: pageTitle("common.organization") }],
  }),
  component: OrganizationLayout,
});

function OrganizationLayout() {
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto border-t p-4">
      <Outlet />
    </div>
  );
}
