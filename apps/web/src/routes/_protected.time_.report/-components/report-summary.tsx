import { panic } from "better-result";
import { useTranslations } from "use-intl";

import type { TimeEntryReport } from "@stll/api-contract/time-entry-report";

import { formatCurrencyAmount } from "@/components/billing/format-currency";
import { useFormatter } from "@/i18n/formatting-context";

import { REPORT_LABELS } from "./report-labels.logic";
import {
  REPORT_METRICS,
  type ReportMetric,
  ReportTile,
  ReportTiles,
} from "./report.pending";

export const ReportSummary = ({ data }: { data: TimeEntryReport }) => {
  const t = useTranslations();
  const format = useFormatter();
  const number = (value: number) =>
    format.number(value, { maximumFractionDigits: 2 });
  const metricValue = (
    key: ReportMetric,
    current: TimeEntryReport["summary"]["current"],
  ) => {
    switch (key) {
      case "billableHours":
        return current.billableMinutes / 60;
      case "billableShare":
        return current.recordedMinutes === 0
          ? 0
          : (current.billableMinutes / current.recordedMinutes) * 100;
      case "pendingEntries":
        return current.pendingEntries;
      case "activeMembers":
        return current.activeMembers;
      default:
        key satisfies never;
        return panic("Unhandled report metric");
    }
  };
  return (
    <ReportTiles>
      {REPORT_METRICS.map(({ key }) => (
        <ReportTile
          key={key}
          label={t(REPORT_LABELS[key])}
          labelText={t(REPORT_LABELS[key])}
        >
          <p className="text-2xl font-medium tabular-nums">
            {key === "billableShare"
              ? format.number(metricValue(key, data.summary.current) / 100, {
                  style: "percent",
                  maximumFractionDigits: 1,
                })
              : number(metricValue(key, data.summary.current))}
          </p>
          <p className="text-muted-foreground text-xs tabular-nums">
            {/* The share moves on a 0 to 100 scale: its change reads in
                percentage points, not as a relative percentage. */}
            {t(
              REPORT_LABELS[
                key === "billableShare" ? "changePoints" : "change"
              ],
              {
                value: number(
                  metricValue(key, data.summary.current) -
                    metricValue(key, data.summary.previous),
                ),
              },
            )}
          </p>
        </ReportTile>
      ))}
      <UnbilledValues values={unbilledValuesOf(data)} />
    </ReportTiles>
  );
};

type CurrencyValues = NonNullable<
  TimeEntryReport["summary"]["current"]["unbilledValues"]
>;

type UnbilledView =
  | { type: "hidden" }
  | { current: CurrencyValues; previous: CurrencyValues; type: "ready" };

/** Amounts are absent for a viewer who may not see them. */
const unbilledValuesOf = (data: TimeEntryReport): UnbilledView => {
  const { current, previous } = data.summary;
  if (current.unbilledValues === null || previous.unbilledValues === null) {
    return { type: "hidden" };
  }
  return {
    current: current.unbilledValues,
    previous: previous.unbilledValues,
    type: "ready",
  };
};

/** Unbilled value per currency, never summed across currencies. */
const UnbilledValues = ({ values }: { values: UnbilledView }) => {
  const t = useTranslations();
  if (values.type === "hidden") {
    return null;
  }
  return (
    <section aria-label={t(REPORT_LABELS.unbilledValue)}>
      <h2 className="text-muted-foreground text-xs">
        {t(REPORT_LABELS.unbilledValue)}
      </h2>
      <CurrencyAmounts current={values.current} previous={values.previous} />
    </section>
  );
};

const CurrencyAmounts = ({
  current,
  previous,
}: {
  current: CurrencyValues;
  previous: CurrencyValues;
}) => {
  const t = useTranslations();
  const format = useFormatter();
  const valueIn = (entries: CurrencyValues, currency: string) =>
    entries.find((entry) => entry.currency === currency)?.value ?? 0;
  const currencies = [
    ...new Set([...current, ...previous].map(({ currency }) => currency)),
  ];
  if (currencies.length === 0) {
    return (
      <p className="text-2xl font-medium tabular-nums">{format.number(0)}</p>
    );
  }
  return currencies.map((currency) => {
    const value = valueIn(current, currency);
    return (
      <div key={currency}>
        <p className="text-2xl font-medium tabular-nums">
          {formatCurrencyAmount(value, currency)}
        </p>
        <p className="text-muted-foreground text-xs tabular-nums">
          {t(REPORT_LABELS.change, {
            value: formatCurrencyAmount(
              value - valueIn(previous, currency),
              currency,
            ),
          })}
        </p>
      </div>
    );
  });
};
