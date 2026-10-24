import { cents, formatMoneyCents, timeEntryAmount } from "@stll/money";
import type { CentsAmount } from "@stll/money";
import { BanknoteIcon } from "@stll/ui/icons";
import { MatterIcon } from "@stll/ui/matter-icon";

import { formatPreviewDate, formatPreviewHours } from "./format";
import { PREVIEW_MATTERS } from "./mock-data";
import type { PreviewMatter } from "./mock-data";
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

export type BillingPreviewEntry = {
  /** `YYYY-MM-DD`; unique within the invoice. */
  date: string;
  description: string;
  billedMinutes: number;
};

/** The invoice's content. Every entry bills at `hourlyRate` (minor units,
 *  minted with `cents` from `@stll/money`) in `currency` (ISO 4217); the
 *  amounts and total are computed. */
export type BillingPreviewData = {
  invoiceNumber: string;
  client: string;
  matter: PreviewMatter;
  currency: string;
  hourlyRate: CentsAmount;
  /** In the order the invoice lists them, usually by date. */
  entries: readonly BillingPreviewEntry[];
};

/** An invoice draft: the matter's time entries in date order with hours,
 *  rate and amount, and the total. Amounts come from the same money helpers
 *  the app bills with. */
export const BillingPreview = ({
  labels,
  locale,
  data = DEFAULT_DATA,
  className,
}: FeaturePreviewProps<BillingPreviewLabels, BillingPreviewData>) => {
  const money = (amountCents: number) =>
    formatMoneyCents({ amountCents, currency: data.currency, locale });
  const rows = data.entries.map((entry) => ({
    ...entry,
    amount: timeEntryAmount({
      billedMinutes: entry.billedMinutes,
      rateAtEntry: data.hourlyRate,
      noCharge: false,
    }),
  }));
  const totalMinutes = rows.reduce((sum, row) => sum + row.billedMinutes, 0);
  const totalCents = rows.reduce((sum, row) => sum + row.amount, 0);

  return (
    <FeaturePreviewSurface
      className={className}
      icon={<BanknoteIcon className="text-muted-foreground size-4 shrink-0" />}
      meta={<span className="tabular-nums">{data.invoiceNumber}</span>}
      title={data.client}
    >
      <div className="flex h-full min-h-0 flex-col p-3">
        <div className="text-muted-foreground mb-2 flex min-w-0 items-center gap-1.5">
          <MatterIcon className="size-3.5 shrink-0" matter={data.matter} />
          <span className="truncate">{data.matter.name}</span>
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
                {formatPreviewHours(locale, row.billedMinutes)}
              </span>
              <span className="text-muted-foreground text-end whitespace-nowrap tabular-nums">
                {money(data.hourlyRate)}
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

// The default content; see `mock-data.ts`.
const DEFAULT_DATA = {
  invoiceNumber: "INV-2026-0187",
  client: "Harbour Logistics Ltd",
  matter: PREVIEW_MATTERS.cargo,
  currency: "EUR",
  hourlyRate: cents(22_000),
  entries: [
    {
      date: "2026-10-02",
      description: "Conflict check and engagement letter",
      billedMinutes: 30,
    },
    {
      date: "2026-10-06",
      description: "Review of carriage contract and bills of lading",
      billedMinutes: 144,
    },
    {
      date: "2026-10-09",
      description: "Call with client on the cargo damage claim",
      billedMinutes: 90,
    },
    {
      date: "2026-10-14",
      description: "Draft letter before action",
      billedMinutes: 210,
    },
    {
      date: "2026-10-16",
      description: "Research on carrier liability limits",
      billedMinutes: 120,
    },
  ],
} as const satisfies BillingPreviewData;
