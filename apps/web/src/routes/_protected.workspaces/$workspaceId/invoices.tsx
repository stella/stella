import { createFileRoute, redirect } from "@tanstack/react-router";

import { BILLING_MATTER_READ_PERMISSION } from "@stll/permissions";

import { isTimeBillingRouteEnabled } from "@/hooks/use-time-billing-preview";
import { ensureMemberPermission } from "@/lib/auth-queries";

import { InvoicesPage } from "./-invoices.page";
import { InvoicesPending } from "./-invoices.pending";

export const Route = createFileRoute(
  "/_protected/workspaces/$workspaceId/invoices",
)({
  beforeLoad: async ({ context, params }) => {
    if (
      !(await ensureMemberPermission({
        queryClient: context.queryClient,
        permissions: BILLING_MATTER_READ_PERMISSION,
      })) ||
      !(await isTimeBillingRouteEnabled(context.queryClient, {
        userId: context.user.id,
        organizationId: context.user.activeOrganizationId,
      }))
    ) {
      throw redirect({
        to: "/workspaces/$workspaceId",
        params: { workspaceId: params.workspaceId },
      });
    }
  },
  component: InvoicesPage,
  pendingComponent: InvoicesPending,
});
