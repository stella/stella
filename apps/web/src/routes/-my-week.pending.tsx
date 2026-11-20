import type { ReactNode } from "react";

import { useSearch } from "@tanstack/react-router";

import { ButtonFace } from "@stll/ui/control-face";
import { ScrollArea } from "@stll/ui/scroll-area";

import { WeekNavigatorFace } from "@/components/billing/week-navigator.pending";
import { plainWeekDate, weekOf } from "@/components/billing/work-week.logic";
import { PendingText } from "@/components/pending-text";
import {
  MyWeekDaySkeleton,
  MyWeekTotalsSkeleton,
} from "@/features/my-week/my-week-day.pending";
import { WeekStripSkeleton } from "@/features/my-week/week-strip.pending";
import { framePendingView } from "@/routes/-pending-view.logic";

export const MyWeekShell = ({ children }: { children: ReactNode }) => (
  <div className="flex h-full flex-col">{children}</div>
);

export const MyWeekHeaderFrame = ({
  title,
  totals,
  navigator,
  actions,
}: {
  title: ReactNode;
  totals: ReactNode;
  navigator: ReactNode;
  actions?: ReactNode;
}) => (
  <header className="flex min-h-12 flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b px-4 py-1.5">
    <div className="min-w-0">
      <h1 className="text-sm font-medium">{title}</h1>
      <div className="text-muted-foreground text-xs tabular-nums">{totals}</div>
    </div>
    <div className="flex flex-wrap items-center gap-2">
      {navigator}
      {actions}
    </div>
  </header>
);

export const MyWeekPending = framePendingView(() => {
  const date = useSearch({ strict: false, select: (search) => search.date });
  const pendingDate = plainWeekDate(date);
  return (
    <MyWeekShell>
      <MyWeekHeaderFrame
        title={<PendingText id="timesheets.week.title" />}
        totals={<MyWeekTotalsSkeleton />}
        navigator={<WeekNavigatorFace date={pendingDate} />}
        actions={
          <>
            <ButtonFace size="sm" variant="default">
              <PendingText id="common.logTime" />
            </ButtonFace>
            <span className="text-foreground opacity-64">
              <PendingText id="billing.timeReport.title" />
            </span>
          </>
        }
      />
      <WeekStripSkeleton
        week={pendingDate === undefined ? undefined : weekOf(pendingDate)}
        selectedDate={pendingDate}
      />
      <ScrollArea className="min-h-0 flex-1">
        <MyWeekDaySkeleton date={pendingDate} />
      </ScrollArea>
    </MyWeekShell>
  );
});
