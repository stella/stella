import { Suspense } from "react";
import type { ReactNode } from "react";

import { useSuspenseInfiniteQuery } from "@tanstack/react-query";
import {
  getRouteApi,
  Link,
  Outlet,
  useMatch,
  useNavigate,
} from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { PlusIcon } from "@stll/ui/icons";
import { TableRow } from "@stll/ui/table";

import { formatCurrencyAmount } from "@/components/billing/format-currency";
import { usePermissions } from "@/hooks/use-permissions";
import { detached } from "@/lib/detached";
import { invoicesInfiniteOptions } from "@/lib/workspaces/queries/invoices";
import { InvoiceExportMenu } from "@/routes/_protected.workspaces/$workspaceId/-components/billing/invoice-export-menu";
import { isPartiallyPaid } from "@/routes/_protected.workspaces/$workspaceId/-components/billing/invoice-payments.logic";
import { InvoiceStatusBadge } from "@/routes/_protected.workspaces/$workspaceId/-components/billing/invoice-status-badge";

import {
  INVOICE_COLUMNS,
  InvoiceCell,
  InvoicesShell,
  InvoicesTableShell,
  InvoicesTableSkeleton,
} from "./-invoices.pending";

const routeApi = getRouteApi("/_protected/workspaces/$workspaceId/invoices");

export function InvoicesPage() {
  const t = useTranslations();
  const canCreateInvoice = usePermissions({ invoice: ["create"] });
  const workspaceId = routeApi.useParams({
    select: (p) => p.workspaceId,
  });

  const invoiceDetailMatch = useMatch({
    from: "/_protected/workspaces/$workspaceId/invoices/$invoiceId",
    shouldThrow: false,
  });
  const newInvoiceMatch = useMatch({
    from: "/_protected/workspaces/$workspaceId/invoices/new",
    shouldThrow: false,
  });

  if (invoiceDetailMatch || newInvoiceMatch) {
    return <Outlet />;
  }

  return (
    <InvoicesShell
      actions={
        <>
          <InvoiceExportMenu workspaceId={workspaceId} />
          {canCreateInvoice && (
            <Link
              params={{ workspaceId }}
              to="/workspaces/$workspaceId/invoices/new"
            >
              <Button size="sm" variant="outline">
                <PlusIcon className="size-4" />
                {t("billing.invoices.createInvoice")}
              </Button>
            </Link>
          )}
        </>
      }
    >
      <Suspense fallback={<InvoicesTableSkeleton />}>
        <InvoicesList workspaceId={workspaceId} />
      </Suspense>
    </InvoicesShell>
  );
}

const PAGE_SIZE = 50;

type InvoiceListItem = Awaited<
  ReturnType<NonNullable<ReturnType<typeof invoicesInfiniteOptions>["queryFn"]>>
>["items"][number];

const InvoicesList = ({ workspaceId }: { workspaceId: string }) => {
  const t = useTranslations();
  const navigate = useNavigate();
  const cells: Record<
    (typeof INVOICE_COLUMNS)[number]["id"],
    (invoice: InvoiceListItem) => ReactNode
  > = {
    invoiceNumber: (invoice) => (
      <span className="font-medium">
        {invoice.invoiceNumber ?? t("billing.invoices.statuses.draft")}
      </span>
    ),
    status: (invoice) => (
      <InvoiceStatusBadge
        partiallyPaid={isPartiallyPaid(invoice)}
        settlement={invoice.settlement}
        status={invoice.status}
      />
    ),
    invoiceDate: (invoice) => invoice.invoiceDate,
    dueDate: (invoice) => invoice.dueDate ?? "—",
    totalAmount: (invoice) =>
      formatCurrencyAmount(invoice.matterShare, invoice.currency),
    reference: (invoice) => invoice.reference ?? "—",
  };
  const { data, fetchNextPage, hasNextPage, isFetchingNextPage } =
    useSuspenseInfiniteQuery(invoicesInfiniteOptions(workspaceId, PAGE_SIZE));
  const invoices = data.pages.flatMap((page) => page.items);

  if (invoices.length === 0) {
    return (
      <div className="text-muted-foreground py-16 text-center text-sm">
        {t("billing.invoices.noInvoices")}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <InvoicesTableShell>
        {invoices.map((invoice) => (
          <TableRow
            className="cursor-pointer"
            key={invoice.id}
            onClick={() => {
              detached(
                navigate({
                  to: "/workspaces/$workspaceId/invoices/$invoiceId",
                  params: {
                    workspaceId,
                    invoiceId: invoice.id,
                  },
                }),
                "invoices.navigate",
              );
            }}
          >
            {INVOICE_COLUMNS.map((column) => (
              <InvoiceCell column={column} key={column.id}>
                {cells[column.id](invoice)}
              </InvoiceCell>
            ))}
          </TableRow>
        ))}
      </InvoicesTableShell>
      {hasNextPage && (
        <div className="flex justify-center">
          <Button
            disabled={isFetchingNextPage}
            onClick={() => {
              detached(fetchNextPage(), "invoices.fetch-next-page");
            }}
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
