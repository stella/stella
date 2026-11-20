import type { ReactNode } from "react";

import { ButtonFace } from "@stll/ui/control-face";
import { DownloadIcon, PlusIcon } from "@stll/ui/icons";
import { ScrollArea } from "@stll/ui/scroll-area";
import {
  Table,
  TableBody,
  TableCellFace,
  TableHead,
  TableHeader,
  TableRow,
  TableSkeletonRows,
} from "@stll/ui/table-shell";
import { cn } from "@stll/ui/utils";

import { PendingText } from "@/components/pending-text";
import { framePendingView } from "@/routes/-pending-view.logic";

export const InvoicesShell = ({
  actions,
  children,
}: {
  actions: ReactNode;
  children: ReactNode;
}) => (
  <div className="flex h-full flex-col">
    <header className="flex items-center justify-between border-b px-4 py-3">
      <h1 className="text-sm font-medium">
        <PendingText id="common.invoices" />
      </h1>
      <div className="flex items-center gap-2">{actions}</div>
    </header>
    <ScrollArea className="flex-1">
      <div className="p-4">{children}</div>
    </ScrollArea>
  </div>
);

type InvoiceColumn = {
  id: string;
  header: Parameters<typeof PendingText>[0]["id"];
  bar: string;
  align?: "start" | "end";
  numeric?: boolean;
  tone?: "muted";
  wrap?: boolean;
};

export const INVOICE_COLUMNS = [
  {
    id: "invoiceNumber",
    header: "billing.invoices.invoiceNumber",
    bar: "h-5 w-24",
  },
  { id: "status", header: "common.status", bar: "h-5 w-16 rounded-md" },
  {
    id: "invoiceDate",
    header: "billing.invoices.invoiceDate",
    numeric: true,
    bar: "h-5 w-20",
  },
  {
    id: "dueDate",
    header: "billing.invoices.dueDate",
    numeric: true,
    tone: "muted",
    bar: "h-5 w-20",
  },
  {
    id: "totalAmount",
    header: "billing.invoices.totalAmount",
    align: "end",
    numeric: true,
    bar: "ms-auto h-5 w-20",
  },
  {
    id: "reference",
    header: "common.reference",
    tone: "muted",
    wrap: true,
    bar: "h-5 w-16",
  },
] as const satisfies readonly InvoiceColumn[];

export const InvoicesTableShell = ({ children }: { children: ReactNode }) => (
  <div className="min-w-0 rounded-lg border">
    <ScrollArea className="h-auto">
      <Table inset="card" scroll="parent">
        <TableHeader surface="muted">
          <TableRow>
            {INVOICE_COLUMNS.map((column: InvoiceColumn) => (
              <TableHead align={column.align} key={column.id}>
                <PendingText id={column.header} />
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>{children}</TableBody>
      </Table>
    </ScrollArea>
  </div>
);

export const InvoiceCell = ({
  column,
  children,
}: {
  column: InvoiceColumn;
  children: ReactNode;
}) => (
  <TableCellFace
    align={column.align}
    className={cn(column.wrap && "whitespace-normal")}
    numeric={column.numeric}
    tone={column.tone}
  >
    {column.wrap ? <span className="leading-5">{children}</span> : children}
  </TableCellFace>
);

export const InvoicesTableSkeleton = () => (
  <InvoicesTableShell>
    <TableSkeletonRows columns={INVOICE_COLUMNS} count={8} />
  </InvoicesTableShell>
);

export const InvoicesPending = framePendingView(() => (
  <InvoicesShell
    actions={
      <>
        <ButtonFace size="sm" variant="outline">
          <DownloadIcon className="size-3.5" />
          <PendingText id="clauses.export" />
        </ButtonFace>
        <ButtonFace size="sm" variant="outline">
          <PlusIcon className="size-4" />
          <PendingText id="billing.invoices.createInvoice" />
        </ButtonFace>
      </>
    }
  >
    <InvoicesTableSkeleton />
  </InvoicesShell>
));
