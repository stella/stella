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
      {data?.summary.current.unbilledValues !== null && (
        <section aria-label={t(REPORT_LABELS.unbilledValue)}>
          <h2 className="text-muted-foreground text-xs">
            {t(REPORT_LABELS.unbilledValue)}
          </h2>
          {data !== undefined &&
            data.summary.current.unbilledValues?.length === 0 &&
            data.summary.previous.unbilledValues?.length === 0 && (
              <p className="text-2xl font-medium tabular-nums">{number(0)}</p>
            )}
          {data === undefined ? (
            <Skeleton className="h-12 w-24" />
          ) : (
            [
              ...new Set([
                ...(data.summary.current.unbilledValues ?? []).map(
                  ({ currency }) => currency,
                ),
                ...(data.summary.previous.unbilledValues ?? []).map(
                  ({ currency }) => currency,
                ),
              ]),
            ].map((currency) => {
              const value =
                data.summary.current.unbilledValues?.find(
                  (entry) => entry.currency === currency,
                )?.value ?? 0;
              return (
                <div key={currency}>
                  <p className="text-2xl font-medium tabular-nums">
                    {formatCurrencyAmount(value, currency)}
                  </p>
                  <p className="text-muted-foreground text-xs tabular-nums">
                    {t(REPORT_LABELS.change, {
                      value: formatCurrencyAmount(
                        value -
                          (data.summary.previous.unbilledValues?.find(
                            (previous) => previous.currency === currency,
                          )?.value ?? 0),
                        currency,
                      ),
                    })}
                  </p>
                </div>
              );
            })
          )}
        </section>
      )}
    </div>
  );
};
