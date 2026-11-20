import { createFileRoute, redirect } from "@tanstack/react-router";

import { ensureMemberPermission } from "@/lib/auth-queries";
import { detached } from "@/lib/detached";
import { ensureRouteQueryData } from "@/lib/react-query";
import { invoicePrefillOptions } from "@/lib/workspaces/queries/invoices";
import { prefetchPendingApprovals } from "@/routes/_protected.workspaces/$workspaceId/-components/billing/new-invoice-loader";

import { NewInvoicePage } from "./-new.page";
import { NewInvoicePending } from "./-new.pending";

export const Route = createFileRoute(
  "/_protected/workspaces/$workspaceId/invoices/new",
)({
  beforeLoad: async ({ context, params }) => {
    if (
      !(await ensureMemberPermission({
        queryClient: context.queryClient,
        permissions: { invoice: ["create"], billing: ["read"] },
      }))
    ) {
      redirect({
        to: "/workspaces/$workspaceId/invoices",
        params: { workspaceId: params.workspaceId },
        throw: true,
      });
    }
  },
  loader: async ({ context, params }) => {
    // A hint only: never awaited, so a failed count cannot block the route.
    detached(
      prefetchPendingApprovals({
        queryClient: context.queryClient,
        userId: context.user.id,
        workspaceId: params.workspaceId,
      }),
      "invoice-composer.prefetch-pending-approvals",
    );
    await ensureRouteQueryData(
      context.queryClient,
      invoicePrefillOptions(params.workspaceId),
    );
  },
  pendingComponent: NewInvoicePending,
  component: NewInvoicePage,
});
