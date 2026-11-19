import type { ReactNode } from "react";

import { ButtonFace, FaceLabelPending } from "@stll/ui/control-face";
import { DirectionalIcon } from "@stll/ui/directional-icon";
import {
  Frame,
  FrameDescription,
  FrameHeader,
  FramePanel,
  FrameTitle,
} from "@stll/ui/frame";
import { ArrowRightIcon } from "@stll/ui/icons";
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

export const COMPOSER_STEPS = [
  { id: "items", label: "billing.invoiceComposer.steps.items" },
  { id: "details", label: "common.details" },
  { id: "issue", label: "billing.invoiceComposer.steps.issue" },
] as const satisfies readonly {
  id: string;
  label: Parameters<typeof PendingText>[0]["id"];
}[];

export type ComposerStep = (typeof COMPOSER_STEPS)[number]["id"];

export const ComposerFrame = ({
  children,
  navigation,
  footer,
}: {
  children: ReactNode;
  navigation: ReactNode;
  footer: ReactNode;
}) => (
  <div className="flex min-h-full flex-col">
    <div className="flex flex-1 flex-col gap-4 p-4 sm:p-6">
      {navigation}
      {children}
    </div>
    {footer}
  </div>
);

export const ComposerStepList = ({ children }: { children: ReactNode }) => (
  <ol className="flex flex-wrap gap-2">{children}</ol>
);

export const ComposerFooterFrame = ({
  summary,
  children,
}: {
  summary: ReactNode;
  children: ReactNode;
}) => (
  <div className="bg-background sticky bottom-0 flex flex-wrap items-center gap-3 border-t px-4 py-3 sm:px-6">
    <span className="text-muted-foreground text-sm tabular-nums">
      {summary}
    </span>
    <span className="flex-1" />
    {children}
  </div>
);

export const InvoiceTimeSection = ({
  title,
  description,
  children,
}: {
  title: ReactNode;
  description: ReactNode;
  children: ReactNode;
}) => (
  <Frame>
    <FrameHeader>
      <FrameTitle>{title}</FrameTitle>
      <FrameDescription>{description}</FrameDescription>
    </FrameHeader>
    {children}
  </Frame>
);

export const InvoiceExpensesSection = ({
  children,
  title,
}: {
  children: ReactNode;
  title: ReactNode;
}) => (
  <Frame>
    <FrameHeader>
      <FrameTitle>{title}</FrameTitle>
    </FrameHeader>
    {children}
  </Frame>
);

const TIME_COLUMNS = [
  { id: "include", label: "billing.invoiceComposer.include", bar: "size-4" },
  { id: "date", label: "common.date", bar: "h-5 w-16" },
  { id: "narrative", label: "billing.narrative", bar: "h-5 w-28" },
  {
    id: "billedHours",
    label: "billing.invoiceComposer.billedHours",
    bar: "h-5 w-12",
    align: "end",
  },
  {
    id: "rate",
    label: "billing.invoiceComposer.rate",
    bar: "h-5 w-12",
    align: "end",
  },
  { id: "amount", label: "billing.amount", bar: "h-5 w-16", align: "end" },
  {
    id: "noCharge",
    label: "billing.invoiceComposer.noCharge",
    bar: "h-5 w-10",
  },
] as const satisfies readonly {
  id: string;
  label: Parameters<typeof PendingText>[0]["id"];
  bar: string;
  align?: "end";
}[];

export const ComposerTimeEntriesTable = ({
  children,
  renderLabel,
}: {
  children: ReactNode;
  renderLabel: (label: (typeof TIME_COLUMNS)[number]["label"]) => ReactNode;
}) => (
  <Table>
    <TableHeader>
      <TableRow>
        {TIME_COLUMNS.map((column) =>
          column.id === "include" ? (
            <TableHead className="w-10" key={column.id}>
              <span className="sr-only">{renderLabel(column.label)}</span>
            </TableHead>
          ) : (
            <TableHead
              align={"align" in column ? column.align : undefined}
              key={column.id}
            >
              {renderLabel(column.label)}
            </TableHead>
          ),
        )}
      </TableRow>
    </TableHeader>
    <TableBody>{children}</TableBody>
  </Table>
);

export const InvoiceComposerSkeleton = () => (
  <ComposerFrame
    navigation={
      <ComposerStepList>
        {COMPOSER_STEPS.map(({ id, label }) => (
          <li key={id}>
            <ButtonFace
              size="chip"
              variant={id === "items" ? "default" : "secondary"}
            >
              <FaceLabelPending className="w-2" />
              <PendingText id={label} />
            </ButtonFace>
          </li>
        ))}
      </ComposerStepList>
    }
    footer={
      <ComposerFooterFrame summary={<Skeleton className="h-5 w-40" />}>
        <ButtonFace size="default" variant="default">
          <PendingText id="billing.invoiceComposer.continueToDetails" />
          <DirectionalIcon className="size-4" icon={ArrowRightIcon} />
        </ButtonFace>
      </ComposerFooterFrame>
    }
  >
    <div className="flex flex-col gap-4">
      <InvoiceTimeSection
        description={<Skeleton className="h-5 w-40" />}
        title={<PendingText id="billing.invoiceComposer.timeEntries" />}
      >
        <ComposerTimeEntriesTable renderLabel={(id) => <PendingText id={id} />}>
          <TableSkeletonRows columns={TIME_COLUMNS} count={3} />
        </ComposerTimeEntriesTable>
      </InvoiceTimeSection>
      <InvoiceExpensesSection title={<PendingText id="common.expenses" />}>
        <FramePanel>
          <Skeleton className="h-5 w-40" />
        </FramePanel>
      </InvoiceExpensesSection>
    </div>
  </ComposerFrame>
);
