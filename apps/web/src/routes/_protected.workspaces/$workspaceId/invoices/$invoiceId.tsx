import { createFileRoute } from "@tanstack/react-router";

import { loadRouteResource } from "@/lib/errors/route-resource";
import { ensureRouteQueryData } from "@/lib/react-query";
import { invoiceByIdOptions } from "@/lib/workspaces/queries/invoices";

import { InvoiceDetailPage } from "./-invoice-detail.page";
import { InvoiceDetailPending } from "./-invoice-detail.pending";

export const Route = createFileRoute(
  "/_protected/workspaces/$workspaceId/invoices/$invoiceId",
)({
  component: InvoiceDetailPage,
  pendingComponent: InvoiceDetailPending,
  loader: async ({ context, params }) => {
    // Prime the invoice query the detail view suspends on so the fetch starts
    // during navigation instead of after the component mounts and suspends.
    await loadRouteResource({
      ids: [params.workspaceId, params.invoiceId],
      load: async () =>
        await ensureRouteQueryData(
          context.queryClient,
          invoiceByIdOptions(params.workspaceId, params.invoiceId),
        ),
    });
  },
  remountDeps: ({ params }) => [params.workspaceId, params.invoiceId],
});
