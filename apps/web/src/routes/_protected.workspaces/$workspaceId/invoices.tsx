import { Suspense } from "react";
import type { ReactNode } from "react";

import { useSuspenseInfiniteQuery } from "@tanstack/react-query";
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
import { Skeleton } from "@stll/ui/components/skeleton";
import { cn } from "@stll/ui/lib/utils";

import { usePermissions } from "@/hooks/use-permissions";
import { formatCurrencyAmount } from "@/routes/_protected.workspaces/$workspaceId/-components/billing/format-currency";
import { InvoiceStatusBadge } from "@/routes/_protected.workspaces/$workspaceId/-components/billing/invoice-status-badge";
import { invoicesInfiniteOptions } from "@/routes/_protected.workspaces/$workspaceId/-queries/invoices";

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
        <Suspense fallback={<InvoicesTableSkeleton />}>
          <InvoicesList workspaceId={workspaceId} />
        </Suspense>
      </div>
    </div>
  );
}

const PAGE_SIZE = 50;

type InvoiceListItem = Awaited<
  ReturnType<NonNullable<ReturnType<typeof invoicesInfiniteOptions>["queryFn"]>>
>["items"][number];

type InvoiceColumn = {
  id: string;
  header: () => ReactNode;
  cell: (invoice: InvoiceListItem) => ReactNode;
  // Header and data cell classes, kept on the column so alignment cannot drift
  // between the live row and the skeleton row.
  headClassName?: string;
  cellClassName?: string;
  // Skeleton placeholder for this column. Defaults to a left-aligned bar.
  skeletonCell?: () => ReactNode;
};

// Single column source of truth: the table header, the live data rows, and the
// loading skeleton all derive from this array, so none can drift from another.
const useInvoiceColumns = (): InvoiceColumn[] => {
  const t = useTranslations();

  return [
    {
      id: "invoiceNumber",
      header: () => t("billing.invoices.invoiceNumber"),
      cell: (invoice) => invoice.invoiceNumber,
      cellClassName: "font-medium",
      skeletonCell: () => <Skeleton className="h-4 w-24" />,
    },
    {
      id: "status",
      header: () => t("common.status"),
      cell: (invoice) => <InvoiceStatusBadge status={invoice.status} />,
      skeletonCell: () => <Skeleton className="h-5 w-16 rounded-md" />,
    },
    {
      id: "invoiceDate",
      header: () => t("billing.invoices.invoiceDate"),
      cell: (invoice) => invoice.invoiceDate,
      cellClassName: "tabular-nums",
      skeletonCell: () => <Skeleton className="h-4 w-20" />,
    },
    {
      id: "dueDate",
      header: () => t("billing.invoices.dueDate"),
      cell: (invoice) => invoice.dueDate ?? "—",
      cellClassName: "text-muted-foreground tabular-nums",
      skeletonCell: () => <Skeleton className="h-4 w-20" />,
    },
    {
      id: "totalAmount",
      header: () => t("billing.invoices.totalAmount"),
      cell: (invoice) =>
        formatCurrencyAmount(invoice.totalAmount, invoice.currency),
      headClassName: "text-end",
      cellClassName: "text-end tabular-nums",
      skeletonCell: () => <Skeleton className="ms-auto h-4 w-20" />,
    },
    {
      id: "reference",
      header: () => t("common.reference"),
      cell: (invoice) => invoice.reference ?? "—",
      cellClassName: "text-muted-foreground",
      skeletonCell: () => <Skeleton className="h-4 w-16" />,
    },
  ];
};

const SKELETON_ROW_COUNT = 8;

// Stable keys so skeleton rows never fall back to array-index keys.
const SKELETON_ROW_KEYS = ["a", "b", "c", "d", "e", "f", "g", "h"] as const;

type InvoicesTableShellProps = {
  columns: InvoiceColumn[];
  children: ReactNode;
};

// Shared table chrome for both the live rows and the loading skeleton: the
// header is built from the column model, the body slot holds whichever rows the
// caller renders (real data or skeleton placeholders).
const InvoicesTableShell = ({ columns, children }: InvoicesTableShellProps) => (
  <div className="overflow-auto rounded-lg border">
    <table className="w-full text-sm">
      <thead>
        <tr className="bg-muted/50 text-muted-foreground border-b text-start">
          {columns.map((column) => (
            <th
              className={cn("px-4 py-2 font-medium", column.headClassName)}
              key={column.id}
            >
              {column.header()}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>{children}</tbody>
    </table>
  </div>
);

// Placeholder rows generated from the same column model as the live table, so
// the skeleton cannot drift: add, remove, or reorder a column and the
// placeholder gains, loses, or moves the matching cell automatically.
const InvoicesTableSkeleton = () => {
  const columns = useInvoiceColumns();

  return (
    <div className="flex flex-col gap-3">
      <InvoicesTableShell columns={columns}>
        {SKELETON_ROW_KEYS.slice(0, SKELETON_ROW_COUNT).map((rowKey) => (
          <tr className="border-b last:border-0" key={rowKey}>
            {columns.map((column) => (
              <td
                className={cn("px-4 py-2.5", column.cellClassName)}
                key={column.id}
              >
                {column.skeletonCell ? (
                  column.skeletonCell()
                ) : (
                  <Skeleton className="h-4 w-3/5" />
                )}
              </td>
            ))}
          </tr>
        ))}
      </InvoicesTableShell>
    </div>
  );
};

const InvoicesList = ({ workspaceId }: { workspaceId: string }) => {
  const t = useTranslations();
  const navigate = useNavigate();
  const columns = useInvoiceColumns();
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
      <InvoicesTableShell columns={columns}>
        {invoices.map((invoice) => (
          <tr
            className="hover:bg-muted/30 cursor-pointer border-b last:border-0"
            key={invoice.id}
            onClick={() => {
              void navigate({
                to: "/workspaces/$workspaceId/invoices/$invoiceId",
                params: {
                  workspaceId,
                  invoiceId: invoice.id,
                },
              });
            }}
          >
            {columns.map((column) => (
              <td
                className={cn("px-4 py-2.5", column.cellClassName)}
                key={column.id}
              >
                {column.cell(invoice)}
              </td>
            ))}
          </tr>
        ))}
      </InvoicesTableShell>
      {hasNextPage && (
        <div className="flex justify-center">
          <Button
            disabled={isFetchingNextPage}
            onClick={() => {
              void fetchNextPage();
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
