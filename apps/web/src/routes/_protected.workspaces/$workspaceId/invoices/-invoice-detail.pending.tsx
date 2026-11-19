import type { ReactNode } from "react";

import { ButtonFace } from "@stll/ui/control-face";
import { DirectionalIcon } from "@stll/ui/directional-icon";
import { ArrowLeftIcon } from "@stll/ui/icons";
import { ScrollArea } from "@stll/ui/scroll-area";
import { Skeleton } from "@stll/ui/skeleton";
import {
  Table,
  TableBody,
  TableHead,
  TableHeader,
  TableRow,
  TableSkeletonRows,
} from "@stll/ui/table-shell";

import { PendingText } from "@/components/pending-text";
import { framePendingView } from "@/routes/-pending-view.logic";

export const InvoiceDetailBackIcon = () => (
  <DirectionalIcon className="size-4" icon={ArrowLeftIcon} />
);

export const InvoiceDetailShell = ({
  back,
  children,
}: {
  back: ReactNode;
  children: ReactNode;
}) => (
  <div className="flex h-full flex-col">
    <header className="flex items-center gap-3 border-b px-4 py-3">
      {back}
      <h1 className="text-sm font-medium">
        <PendingText id="billing.invoices.invoiceDetail" />
      </h1>
    </header>
    <ScrollArea className="flex-1">
      <div className="p-6">{children}</div>
    </ScrollArea>
  </div>
);

export const InvoiceDetailBody = ({ children }: { children: ReactNode }) => (
  <div className="mx-auto flex max-w-4xl flex-col gap-6">{children}</div>
);

export const InvoiceDetailInfo = ({ children }: { children: ReactNode }) => (
  <div className="grid grid-cols-2 gap-4 rounded-lg border p-4 sm:grid-cols-4">
    {children}
  </div>
);

export const InfoCell = ({
  label,
  value,
}: {
  label: ReactNode;
  value: ReactNode;
}) => (
  <div>
    <div className="text-muted-foreground text-xs">{label}</div>
    <div className="mt-0.5 text-sm font-medium tabular-nums">{value}</div>
  </div>
);

export const InvoiceEntrySection = ({
  summary,
  children,
}: {
  summary: ReactNode;
  children: ReactNode;
}) => (
  <section className="rounded-lg border">
    <div className="flex items-center justify-between border-b px-4 py-3">
      <h3 className="text-sm font-medium">
        <PendingText id="billing.invoices.linkedTimeEntries" />
      </h3>
      <div className="text-muted-foreground text-xs">{summary}</div>
    </div>
    {children}
  </section>
);

const ENTRY_COLUMNS = [
  {
    id: "context",
    header: "chat.composerMenu.context",
    align: "start",
    bar: "h-5 w-24",
  },
  { id: "date", header: "common.date", align: "start", bar: "h-5 w-20" },
  {
    id: "narrative",
    header: "billing.narrative",
    align: "start",
    bar: "h-5 w-36",
  },
  { id: "hours", header: "billing.hours", align: "end", bar: "h-5 w-12" },
  { id: "amount", header: "billing.amount", align: "end", bar: "h-5 w-12" },
] as const;

export const InvoiceEntryTable = ({
  children,
  editable = false,
}: {
  children: ReactNode;
  editable?: boolean;
}) => (
  <ScrollArea className="h-auto">
    <Table inset="card" scroll="parent">
      <TableHeader>
        <TableRow>
          {ENTRY_COLUMNS.map((column) => (
            <TableHead align={column.align} key={column.id}>
              <PendingText id={column.header} />
            </TableHead>
          ))}
          {editable && <TableHead className="w-10" />}
        </TableRow>
      </TableHeader>
      <TableBody>{children}</TableBody>
    </Table>
  </ScrollArea>
);

const INFO_LABELS = [
  { id: "billing.invoices.invoiceDate" },
  { id: "billing.invoices.dueDate" },
  { id: "billing.invoices.totalAmount" },
] as const;

export const InvoiceDetailSkeleton = () => (
  <InvoiceDetailBody>
    <div className="flex items-start justify-between">
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-3">
          <Skeleton className="h-7 w-40" />
          <Skeleton className="h-5 w-16 rounded-md" />
        </div>
        <Skeleton className="h-5 w-28" />
      </div>
      <div className="flex items-center gap-2">
        <Skeleton className="h-8 w-24 rounded-md" />
        <Skeleton className="h-8 w-24 rounded-md" />
      </div>
    </div>
    <InvoiceDetailInfo>
      {INFO_LABELS.map(({ id }) => (
        <InfoCell
          key={id}
          label={<PendingText barClassName="w-16" id={id} />}
          value={<Skeleton className="h-5 w-24" />}
        />
      ))}
    </InvoiceDetailInfo>
    <InvoiceEntrySection summary={<Skeleton className="h-4 w-16" />}>
      <InvoiceEntryTable>
        <TableSkeletonRows columns={ENTRY_COLUMNS} />
      </InvoiceEntryTable>
    </InvoiceEntrySection>
  </InvoiceDetailBody>
);

export const InvoiceDetailPending = framePendingView(() => (
  <InvoiceDetailShell
    back={
      <ButtonFace size="icon" variant="ghost">
        <InvoiceDetailBackIcon />
      </ButtonFace>
    }
  >
    <InvoiceDetailSkeleton />
  </InvoiceDetailShell>
));
