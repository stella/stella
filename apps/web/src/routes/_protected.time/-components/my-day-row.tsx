import type { ReactNode } from "react";

import { useTranslations } from "use-intl";

import { BidiText } from "@stll/ui/bidi-text";

import { useFormatter } from "@/i18n/formatting-context";

import type { MyDayEntry } from "./my-day.logic";

type MyDayRowProps = {
  entry: MyDayEntry;
  renderMatter: (
    entry: Extract<MyDayEntry, { activityGroup: "client" }>,
  ) => ReactNode;
};

export const MyDayRow = ({ entry, renderMatter }: MyDayRowProps) => {
  const format = useFormatter();
  const tBilling = useTranslations("billing");
  const tCommon = useTranslations("common");
  const tDay = useTranslations("timesheets.day");
  if (entry.activityGroup === "absence") {
    return (
      <li className="flex flex-wrap items-start justify-between gap-3 p-4">
        <div className="min-w-0 flex-1 space-y-1">
          <p className="text-sm font-medium">
            {tDay(`absenceKinds.${entry.kind}`)}
          </p>
          <p className="text-muted-foreground text-xs">{tDay("absence")}</p>
        </div>
        <p className="text-end text-sm">
          {entry.coverage === "full"
            ? tDay("fullDay")
            : tDay(`halfDaySegments.${entry.halfDaySegment}`)}
        </p>
      </li>
    );
  }
  return (
    <li className="flex flex-wrap items-start justify-between gap-3 p-4">
      <div className="min-w-0 flex-1 space-y-1">
        {entry.activityGroup === "internal" ? (
          <p className="text-sm font-medium">{tDay("internalWork")}</p>
        ) : (
          <>
            {renderMatter(entry)}
            <p className="text-muted-foreground text-xs">
              {tBilling("clientWork")}
            </p>
            {entry.workspaceReference && (
              <BidiText as="p" className="text-muted-foreground text-xs">
                {entry.workspaceReference}
              </BidiText>
            )}
          </>
        )}
        {entry.narrative && (
          <BidiText as="p" className="text-muted-foreground text-sm">
            {entry.narrative}
          </BidiText>
        )}
      </div>
      <div className="space-y-1 text-end text-sm">
        <p className="font-medium tabular-nums">
          {entry.timerStartedAt === null
            ? format.number(entry.durationMinutes, {
                style: "unit",
                unit: "minute",
                unitDisplay: "short",
              })
            : tCommon("running")}
        </p>
        <p className="text-muted-foreground text-xs">
          {tBilling(`statuses.${entry.status}`)}
        </p>
        {entry.activityGroup === "client" && (
          <p className="text-muted-foreground text-xs">
            {tBilling(entry.billable ? "billable" : "nonBillable")}
          </p>
        )}
      </div>
    </li>
  );
};
