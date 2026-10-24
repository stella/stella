import { cents, formatMoneyCents, timeEntryAmount } from "@stll/money";
import { BanknoteIcon } from "@stll/ui/icons";
import { MatterIcon } from "@stll/ui/matter-icon";

import { formatPreviewDate, formatPreviewHours } from "./format";
import { PREVIEW_MATTERS } from "./mock-data";
import { FeaturePreviewSurface } from "./surface";
import type { FeaturePreviewProps } from "./surface";

export type BillingPreviewLabels = {
  /** Column headings of the invoice's time entries: date, description,
   *  billed time ("Hours"), rate and fee ("Amount"). */
  date: string;
  description: string;
  billedTime: string;
  rate: string;
  fee: string;
  /** Label of the invoice's total row. */
  summary: string;
};

/** An invoice draft: the matter's time entries in date order with hours,
 *  rate and amount, and the total. Amounts come from the same money helpers
 *  the app bills with. */
export const BillingPreview = ({
  labels,
  locale,
  className,
}: FeaturePreviewProps<BillingPreviewLabels>) => {
  const money = (amountCents: number) =>
    formatMoneyCents({ amountCents, currency: CURRENCY, locale });
  const rows = ENTRIES.map((entry) => ({
    ...entry,
    amount: timeEntryAmount({
      billedMinutes: entry.minutes,
      rateAtEntry: HOURLY_RATE,
      noCharge: false,
    }),
  }));
  const totalMinutes = rows.reduce((sum, row) => sum + row.minutes, 0);
  const totalCents = rows.reduce((sum, row) => sum + row.amount, 0);

  return (
    <FeaturePreviewSurface
      className={className}
      icon={<BanknoteIcon className="text-muted-foreground size-4 shrink-0" />}
      meta={<span className="tabular-nums">{INVOICE.number}</span>}
      title={INVOICE.client}
    >
      <div className="flex h-full min-h-0 flex-col p-3">
        <div className="text-muted-foreground mb-2 flex min-w-0 items-center gap-1.5">
          <MatterIcon className="size-3.5 shrink-0" matter={INVOICE.matter} />
          <span className="truncate">{INVOICE.matter.name}</span>
        </div>
        <div className="grid grid-cols-[auto_minmax(0,1fr)_auto_auto_auto] gap-x-4">
          <div className="text-muted-foreground col-span-full grid grid-cols-subgrid border-b pb-1.5 font-medium">
            <span>{labels.date}</span>
            <span>{labels.description}</span>
            <span className="text-end">{labels.billedTime}</span>
            <span className="text-end">{labels.rate}</span>
            <span className="text-end">{labels.fee}</span>
          </div>
          {rows.map((row) => (
            <div
              className="col-span-full grid grid-cols-subgrid items-baseline border-b py-2"
              key={row.date}
            >
              <span className="text-muted-foreground whitespace-nowrap tabular-nums">
                {formatPreviewDate({
                  locale,
                  date: row.date,
                  options: { day: "numeric", month: "short", year: "numeric" },
                })}
              </span>
              <span className="truncate">{row.description}</span>
              <span className="text-end tabular-nums">
                {formatPreviewHours(locale, row.minutes)}
              </span>
              <span className="text-muted-foreground text-end whitespace-nowrap tabular-nums">
                {money(HOURLY_RATE)}
              </span>
              <span className="text-end whitespace-nowrap tabular-nums">
                {money(row.amount)}
              </span>
            </div>
          ))}
          <div className="col-span-full grid grid-cols-subgrid pt-2.5 text-sm font-semibold">
            <span className="col-span-2">{labels.summary}</span>
            <span className="text-end tabular-nums">
              {formatPreviewHours(locale, totalMinutes)}
            </span>
            <span />
            <span className="text-end whitespace-nowrap tabular-nums">
              {money(totalCents)}
            </span>
          </div>
        </div>
      </div>
    </FeaturePreviewSurface>
  );
};

// Mock content depicting user data, not interface text; deliberately
// untranslated.
const CURRENCY = "EUR";
const HOURLY_RATE = cents(22_000);

const INVOICE = {
  number: "INV-2026-0187",
  client: "Harbour Logistics Ltd",
  matter: PREVIEW_MATTERS.cargo,
} as const;

// Chronological, as an invoice lists them.
const ENTRIES = [
  {
    date: "2026-10-02",
    description: "Conflict check and engagement letter",
    minutes: 30,
  },
  {
    date: "2026-10-06",
    description: "Review of carriage contract and bills of lading",
    minutes: 144,
  },
  {
    date: "2026-10-09",
    description: "Call with client on the cargo damage claim",
    minutes: 90,
  },
  {
    date: "2026-10-14",
    description: "Draft letter before action",
    minutes: 210,
  },
  {
    date: "2026-10-16",
    description: "Research on carrier liability limits",
    minutes: 120,
  },
] as const;
