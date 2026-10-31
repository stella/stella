import { panic } from "better-result";
import { useTranslations } from "use-intl";

import type { TimeEntryReport } from "@stll/api-contract/time-entry-report";
import { Skeleton } from "@stll/ui/skeleton";

import { formatCurrencyAmount } from "@/components/billing/format-currency";
import { useFormatter } from "@/i18n/formatting-context";

import { REPORT_LABELS } from "./report-labels";

export const ReportSummary = ({
  data,
}: {
  data: TimeEntryReport | undefined;
}) => {
  const t = useTranslations();
  const format = useFormatter();
  const number = (value: number) =>
    format.number(value, { maximumFractionDigits: 2 });
  const metrics = [
    { key: "billableHours" },
    { key: "billableShare" },
    { key: "pendingEntries" },
    { key: "activeMembers" },
  ] as const;
  const metricValue = (
    key: (typeof metrics)[number]["key"],
    current: NonNullable<typeof data>["summary"]["current"],
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
    <div className="flex flex-wrap gap-6 py-4">
      {metrics.map(({ key }) => (
        <section
          className="min-w-32"
          key={key}
          aria-label={t(REPORT_LABELS[key])}
        >
          <h2 className="text-muted-foreground text-xs">
            {t(REPORT_LABELS[key])}
          </h2>
          {data === undefined ? (
            <Skeleton className="h-12 w-24" />
          ) : (
            <>
              <p className="text-2xl font-medium tabular-nums">
                {key === "billableShare"
                  ? format.number(
                      metricValue(key, data.summary.current) / 100,
                      { style: "percent", maximumFractionDigits: 1 },
                    )
                  : number(metricValue(key, data.summary.current))}
              </p>
              <p className="text-muted-foreground text-xs tabular-nums">
                {t(REPORT_LABELS.change, {
                  value: number(
                    metricValue(key, data.summary.current) -
                      metricValue(key, data.summary.previous),
                  ),
                })}
              </p>
            </>
          )}
        </section>
      ))}
      <UnbilledValues values={unbilledValuesOf(data)} />
    </div>
  );
};

type CurrencyValues = NonNullable<
  TimeEntryReport["summary"]["current"]["unbilledValues"]
>;

type UnbilledView =
  | { type: "hidden" }
  | { type: "loading" }
  | { current: CurrencyValues; previous: CurrencyValues; type: "ready" };

/** Amounts are absent for a viewer who may not see them. */
const unbilledValuesOf = (data: TimeEntryReport | undefined): UnbilledView => {
  if (data === undefined) {
    return { type: "loading" };
  }
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
      {values.type === "loading" ? (
        <Skeleton className="h-12 w-24" />
      ) : (
        <CurrencyAmounts current={values.current} previous={values.previous} />
      )}
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
