import { useState } from "react";
import type { ReactNode } from "react";

import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { ScrollArea } from "@stll/ui/scroll-area";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@stll/ui/select";
import {
  Sheet,
  SheetDescription,
  SheetHeader,
  SheetPopup,
  SheetTitle,
} from "@stll/ui/sheet";
import { Skeleton } from "@stll/ui/skeleton";

import {
  InvoiceComposer,
  IssuedState,
} from "@/components/billing/invoice-composer";
import type { SavedInvoice } from "@/components/billing/invoice-composer";
import { billableCurrencies } from "@/components/billing/invoice-composer.logic";
import { ContactReadError } from "@/components/contact-read-error";
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
  const [chosenCurrency, setChosenCurrency] = useState<string | null>(null);
  // Saving refreshes the prefill below, which may then offer other work or
  // none, so the confirmation lives above everything the prefill decides.
  const [saved, setSaved] = useState<SavedInvoice | null>(null);
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
  const currencies =
    matters === undefined
      ? []
      : billableCurrencies(matters.map((matter) => matter.prefill));
  // A choice the refreshed work no longer offers falls back to the default.
  const currency =
    chosenCurrency !== null && currencies.includes(chosenCurrency)
      ? chosenCurrency
      : currencies.at(0);
  // An invoice has one currency: only the matters with work in it take part.
  const currencyMatters = matters?.filter(
    (matter) =>
      matter.prefill.timeEntries.some((entry) => entry.currency === currency) ||
      matter.prefill.expenses.some((expense) => expense.currency === currency),
  );
  const first = currencyMatters?.at(0);
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
      <ContactReadError
        error={query.error}
        onRetry={() =>
          detached(query.refetch(), "client-invoice-composer.refetch")
        }
      />
    );
  } else if (
    first === undefined ||
    currency === undefined ||
    currencyMatters === undefined
  ) {
    content = (
      <p className="text-muted-foreground p-6 text-sm">
        {t("billing.invoiceComposer.nothingToBill")}
      </p>
    );
  } else {
    content = (
      <InvoiceComposer
        key={`${clientId}:${periodStart ?? ""}:${periodEnd ?? ""}:${currency}`}
        onSaved={setSaved}
        workspaceId={first.workspaceId}
        client={{ clientId, matters: currencyMatters }}
        prefill={{
          ...first.prefill,
          currency,
          billingMode: "hourly",
          flatFeeAmount: null,
          timeEntries: currencyMatters.flatMap(
            (matter) => matter.prefill.timeEntries,
          ),
          expenses: currencyMatters.flatMap(
            (matter) => matter.prefill.expenses,
          ),
        }}
      />
    );
  }
  if (saved !== null) {
    return (
      <IssuedState
        actions={
          <Button onClick={() => setSaved(null)} variant="outline">
            {t("billing.invoices.createInvoice")}
          </Button>
        }
        buyerName={saved.buyerName}
        invoice={saved.invoice}
        workspaceId={saved.invoice.workspaceId}
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
        {currency !== undefined && currencies.length > 1 && (
          <div className="flex flex-col gap-1.5">
            <label
              htmlFor="client-invoice-currency"
              className="text-sm font-medium"
            >
              {t("common.currency")}
            </label>
            <Select
              onValueChange={(value) => {
                const next = currencies.find((option) => option === value);
                if (next !== undefined) {
                  setChosenCurrency(next);
                }
              }}
              value={currency}
            >
              <SelectTrigger className="w-28" id="client-invoice-currency">
                <SelectValue>{currency}</SelectValue>
              </SelectTrigger>
              <SelectPopup>
                {currencies.map((option) => (
                  <SelectItem key={option} value={option}>
                    {option}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          </div>
        )}
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
