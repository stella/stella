import { Suspense, useState } from "react";

import { useSuspenseQuery } from "@tanstack/react-query";
import {
  createFileRoute,
  Link,
  Outlet,
  useMatch,
  useNavigate,
} from "@tanstack/react-router";
import { PlusIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/components/button";

import { usePermissions } from "@/hooks/use-permissions";
import { formatCurrencyAmount } from "@/routes/_protected.workspaces/$workspaceId/-components/billing/format-currency";
import { InvoiceStatusBadge } from "@/routes/_protected.workspaces/$workspaceId/-components/billing/invoice-status-badge";
import { invoicesOptions } from "@/routes/_protected.workspaces/$workspaceId/-queries/invoices";

export const Route = createFileRoute(
  "/_protected/workspaces/$workspaceId/invoices",
)({
  component: InvoicesPage,
});

function InvoicesPage() {
  const t = useTranslations();
  const canCreateInvoice = usePermissions({ invoice: ["create"] });
  const workspaceId = Route.useParams({
    select: (p) => p.workspaceId,
  });

  const invoiceDetailMatch = useMatch({
    from: "/_protected/workspaces/$workspaceId/invoices/$invoiceId",
    shouldThrow: false,
  });

  if (invoiceDetailMatch) {
    return <Outlet />;
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b px-4 py-3">
        <h1 className="text-sm font-medium">{t("common.invoices")}</h1>
        {canCreateInvoice && (
          <Link
            params={{ workspaceId }}
            search={{}}
            to="/workspaces/$workspaceId/invoices"
          >
            <Button size="sm" variant="outline">
              <PlusIcon className="size-4" />
              {t("billing.invoices.createInvoice")}
            </Button>
          </Link>
        )}
      </div>

      <div className="flex-1 overflow-auto p-4">
        <Suspense
          fallback={
            <div className="text-muted-foreground py-8 text-center text-sm">
              {t("billing.loading")}
            </div>
          }
        >
          <InvoicesList workspaceId={workspaceId} />
        </Suspense>
      </div>
    </div>
  );
}

const PAGE_SIZE = 50;

const InvoicesList = ({ workspaceId }: { workspaceId: string }) => {
  const t = useTranslations();
  const navigate = useNavigate();
  const [limit, setLimit] = useState(PAGE_SIZE);
  const { data } = useSuspenseQuery(invoicesOptions(workspaceId, { limit }));

  if (data.items.length === 0) {
    return (
      <div className="text-muted-foreground py-16 text-center text-sm">
        {t("billing.invoices.noInvoices")}
      </div>
    );
  }

  const hasMore = data.nextCursor !== null;

  return (
    <div className="flex flex-col gap-3">
      <div className="overflow-auto rounded-lg border">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-muted/50 text-muted-foreground border-b text-start">
              <th className="px-4 py-2 font-medium">
                {t("billing.invoices.invoiceNumber")}
              </th>
              <th className="px-4 py-2 font-medium">{t("common.status")}</th>
              <th className="px-4 py-2 font-medium">
                {t("billing.invoices.invoiceDate")}
              </th>
              <th className="px-4 py-2 font-medium">
                {t("billing.invoices.dueDate")}
              </th>
              <th className="px-4 py-2 text-end font-medium">
                {t("billing.invoices.totalAmount")}
              </th>
              <th className="px-4 py-2 font-medium">{t("common.reference")}</th>
            </tr>
          </thead>
          <tbody>
            {data.items.map((invoice) => (
              <tr
                className="hover:bg-muted/30 cursor-pointer border-b last:border-0"
                key={invoice.id}
                onClick={() => {
                  void (async () =>
                    await navigate({
                      to: "/workspaces/$workspaceId/invoices/$invoiceId",
                      params: {
                        workspaceId,
                        invoiceId: invoice.id,
                      },
                    }))();
                }}
              >
                <td className="px-4 py-2.5 font-medium">
                  {invoice.invoiceNumber}
                </td>
                <td className="px-4 py-2.5">
                  <InvoiceStatusBadge status={invoice.status} />
                </td>
                <td className="px-4 py-2.5 tabular-nums">
                  {invoice.invoiceDate}
                </td>
                <td className="text-muted-foreground px-4 py-2.5 tabular-nums">
                  {invoice.dueDate ?? "—"}
                </td>
                <td className="px-4 py-2.5 text-end tabular-nums">
                  {formatCurrencyAmount(invoice.totalAmount, invoice.currency)}
                </td>
                <td className="text-muted-foreground px-4 py-2.5">
                  {invoice.reference ?? "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {hasMore && (
        <div className="flex justify-center">
          <Button
            onClick={() => setLimit((l) => l + PAGE_SIZE)}
            size="sm"
            variant="ghost"
          >
            {t("common.loadMore")}
          </Button>
        </div>
      )}
    </div>
  );
};
