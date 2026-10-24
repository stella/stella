import { useState } from "react";
import type { ReactNode } from "react";

import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { ScrollArea } from "@stll/ui/scroll-area";
import {
  Sheet,
  SheetDescription,
  SheetHeader,
  SheetPopup,
  SheetTitle,
} from "@stll/ui/sheet";
import { Skeleton } from "@stll/ui/skeleton";

import { InvoiceComposer } from "@/components/billing/invoice-composer";
import { DatePickerPopover } from "@/components/date-picker-popover";
import { detached } from "@/lib/detached";
import { clientInvoicePrefillOptions } from "@/lib/workspaces/queries/invoices";

type ClientInvoiceComposerProps = {
  clientId: string;
  clientName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

export const ClientInvoiceComposer = ({
  clientId,
  clientName,
  open,
  onOpenChange,
}: ClientInvoiceComposerProps) => {
  const t = useTranslations();
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetPopup side="block-end">
        <SheetHeader>
          <SheetTitle>{t("billing.clientComposer.title")}</SheetTitle>
          <SheetDescription>
            <bdi>{clientName}</bdi>
          </SheetDescription>
        </SheetHeader>
        <ScrollArea className="min-h-0 flex-1">
          {open && <ClientInvoiceSelection clientId={clientId} />}
        </ScrollArea>
      </SheetPopup>
    </Sheet>
  );
};

const ClientInvoiceSelection = ({ clientId }: { clientId: string }) => {
  const t = useTranslations();
  const [periodStart, setPeriodStart] = useState<string | null>(null);
  const [periodEnd, setPeriodEnd] = useState<string | null>(null);
  const query = useQuery(
    clientInvoicePrefillOptions(clientId, { periodStart, periodEnd }),
  );
  const matters = query.data?.matters.filter(
    (matter) => matter.prefill.billingMode !== "flat_fee",
  );
  const hasFlatFeeMatters =
    query.data?.matters.some(
      (matter) => matter.prefill.billingMode === "flat_fee",
    ) ?? false;
  const first = matters?.find(
    (matter) =>
      matter.prefill.currency !== null &&
      matter.prefill.timeEntries.length + matter.prefill.expenses.length > 0,
  );
  const validPeriod =
    periodStart === null || periodEnd === null || periodStart <= periodEnd;
  let content: ReactNode;
  if (!validPeriod) {
    content = (
      <p role="alert" className="text-destructive px-4 text-sm sm:px-6">
        {t("billing.clientComposer.invalidPeriod")}
      </p>
    );
  } else if (query.isPending) {
    content = (
      <div className="flex flex-col gap-4 p-6">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  } else if (query.isError) {
    content = (
      <div className="flex flex-col items-start gap-2 p-6">
        <p role="alert" className="text-destructive text-sm">
          {t("billing.clientComposer.loadFailed")}
        </p>
        <Button
          onClick={() =>
            detached(query.refetch(), "client-invoice-composer.refetch")
          }
          variant="outline"
        >
          {t("common.retry")}
        </Button>
      </div>
    );
  } else if (first === undefined || matters === undefined) {
    content = (
      <p className="text-muted-foreground p-6 text-sm">
        {t("billing.invoiceComposer.nothingToBill")}
      </p>
    );
  } else {
    content = (
      <InvoiceComposer
        key={`${clientId}:${periodStart ?? ""}:${periodEnd ?? ""}`}
        workspaceId={first.workspaceId}
        client={{ clientId, matters }}
        prefill={{
          ...first.prefill,
          billingMode: "hourly",
          flatFeeAmount: null,
          timeEntries: matters.flatMap((matter) => matter.prefill.timeEntries),
          expenses: matters.flatMap((matter) => matter.prefill.expenses),
        }}
      />
    );
  }
  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-4">
      <div className="flex flex-wrap gap-4 px-4 sm:px-6">
        <div className="flex flex-col gap-1.5">
          <label
            htmlFor="client-invoice-period-start"
            className="text-sm font-medium"
          >
            {t("billing.clientComposer.periodStart")}
          </label>
          <DatePickerPopover
            id="client-invoice-period-start"
            value={periodStart}
            onChange={setPeriodStart}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <label
            htmlFor="client-invoice-period-end"
            className="text-sm font-medium"
          >
            {t("billing.clientComposer.periodEnd")}
          </label>
          <DatePickerPopover
            id="client-invoice-period-end"
            value={periodEnd}
            onChange={setPeriodEnd}
          />
        </div>
      </div>
      {hasFlatFeeMatters && (
        <p className="text-muted-foreground px-4 text-sm sm:px-6">
          {t("billing.clientComposer.flatFeeNote")}
        </p>
      )}
      {content}
    </div>
  );
};
