import type { ReactNode } from "react";

import { ButtonFace, FaceLabelPending } from "@stll/ui/control-face";
import { PencilIcon } from "@stll/ui/icons";
import { InlineSkeleton } from "@stll/ui/skeleton";

import { PendingDate } from "@/components/pending-text";

export const MY_WEEK_LONG_DAY = {
  weekday: "long",
  day: "numeric",
  month: "long",
  timeZone: "UTC",
} as const satisfies Intl.DateTimeFormatOptions;

export const TimeEntryRow = ({
  children,
  duration,
  action,
}: {
  children: ReactNode;
  duration: ReactNode;
  action?: ReactNode;
}) => (
  <li className="flex min-h-14 items-center gap-3 px-3 py-2">
    <div className="min-w-0 flex-1">{children}</div>
    <span className="shrink-0 text-sm tabular-nums">{duration}</span>
    {action}
  </li>
);

const TimeEntryRowSkeleton = () => (
  <TimeEntryRow
    duration={<FaceLabelPending className="w-10" />}
    action={
      <ButtonFace className="size-11" size="icon" variant="ghost">
        <PencilIcon className="size-4" />
      </ButtonFace>
    }
  >
    <div className="flex flex-col items-start">
      <div className="text-xs">
        <FaceLabelPending className="w-24" />
      </div>
      <div className="text-sm">
        <FaceLabelPending className="w-40 max-w-full" />
      </div>
      <div className="text-xs">
        <FaceLabelPending className="w-20" />
      </div>
    </div>
  </TimeEntryRow>
);

export const MyWeekDayShell = ({
  dateLabel,
  duration,
  children,
}: {
  dateLabel: ReactNode;
  duration: ReactNode;
  children: ReactNode;
}) => (
  <section
    aria-labelledby="my-week-day-title"
    className="mx-auto flex w-full max-w-4xl flex-col gap-3 p-4"
  >
    <div className="flex items-baseline justify-between gap-3">
      <h2 className="text-sm font-medium" id="my-week-day-title">
        {dateLabel}
      </h2>
      <span className="text-sm font-medium tabular-nums">{duration}</span>
    </div>
    {children}
  </section>
);

export const MyWeekEntryList = ({
  children,
  label,
  busy,
}: {
  children: ReactNode;
  label?: string;
  busy?: boolean;
}) => (
  <ul
    aria-busy={busy}
    aria-label={label}
    className="divide-y rounded-lg border"
  >
    {children}
  </ul>
);

export const MyWeekDaySkeleton = ({ date }: { date?: string | undefined }) => (
  <MyWeekDayShell
    dateLabel={
      date === undefined ? (
        <FaceLabelPending className="w-32" />
      ) : (
        <PendingDate date={date} options={MY_WEEK_LONG_DAY} />
      )
    }
    duration={<FaceLabelPending className="w-10" />}
  >
    <MyWeekEntryList busy>
      <TimeEntryRowSkeleton />
      <TimeEntryRowSkeleton />
      <TimeEntryRowSkeleton />
    </MyWeekEntryList>
  </MyWeekDayShell>
);

export const MyWeekTotalsSkeleton = () => (
  <InlineSkeleton className="inline-block h-2.5 w-32 align-middle" />
);
