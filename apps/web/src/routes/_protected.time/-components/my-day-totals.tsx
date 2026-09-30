import { useTranslations } from "use-intl";

import { useFormatter } from "@/i18n/formatting-context";

import { summarizeMyDay, type MyDayPage } from "./my-day.logic";

export const MyDayTotals = ({ pages }: { pages: readonly MyDayPage[] }) => {
  const tBilling = useTranslations("billing");
  const tDay = useTranslations("timesheets.day");
  const tCommon = useTranslations("common");
  const format = useFormatter();
  const totals = summarizeMyDay(pages);
  if (totals === null) {
    return null;
  }
  return (
    <dl className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
      {(["client", "internal"] as const).map((group) => (
        <div className="flex items-center gap-2" key={group}>
          <dt className="text-muted-foreground">
            {group === "client" ? tBilling("clientWork") : tDay("internalWork")}
          </dt>
          <dd className="font-medium tabular-nums">
            {format.number(totals[group].minutes, {
              style: "unit",
              unit: "minute",
              unitDisplay: "short",
            })}
            {totals[group].running && (
              <span className="text-muted-foreground ms-2 font-normal">
                {tCommon("running")}
              </span>
            )}
          </dd>
        </div>
      ))}
      <div className="flex items-center gap-2">
        <dt className="text-muted-foreground">{tDay("absence")}</dt>
        <dd className="font-medium tabular-nums">
          {format.number(totals.absence.days, {
            style: "unit",
            unit: "day",
            unitDisplay: "short",
          })}
        </dd>
      </div>
    </dl>
  );
};
