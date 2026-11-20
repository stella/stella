import type { ReactNode } from "react";

import { ButtonFace, FaceLabelPending } from "@stll/ui/control-face";
import { PlusIcon } from "@stll/ui/icons";

import { PendingText } from "@/components/pending-text";

export const PersonalTimesheetDayLayout = ({
  actions,
  children,
  summary,
}: {
  actions: ReactNode;
  children: ReactNode;
  summary: ReactNode;
}) => (
  <div className="flex flex-col gap-3">
    <div className="flex min-h-11 flex-wrap items-center justify-between gap-3">
      <span className="text-sm font-medium tabular-nums">{summary}</span>
      {actions}
    </div>
    {children}
  </div>
);

export const PersonalTimesheetEntries = ({
  children,
}: {
  children: ReactNode;
}) => <div className="flex flex-col gap-2">{children}</div>;

export const PersonalTimesheetEntryLayout = ({
  actions,
  duration,
  narrative,
}: {
  actions?: ReactNode;
  duration: ReactNode;
  narrative: ReactNode;
}) => (
  <div className="flex min-h-14 items-center gap-3 rounded-lg border px-3 py-2">
    <div className="min-w-0 flex-1">{narrative}</div>
    <span className="text-muted-foreground shrink-0 text-sm tabular-nums">
      {duration}
    </span>
    {actions}
  </div>
);

const PersonalTimesheetEntrySkeleton = () => (
  <PersonalTimesheetEntryLayout
    duration={<FaceLabelPending className="w-12" />}
    narrative={<FaceLabelPending className="w-1/2" />}
  />
);

export const PersonalTimesheetDaySkeleton = ({
  mayLogTime = false,
}: {
  mayLogTime?: boolean;
}) => (
  <div aria-hidden="true">
    <PersonalTimesheetDayLayout
      actions={
        mayLogTime && (
          <ButtonFace size="sm" variant="default">
            <PlusIcon className="size-4" />
            <PendingText id="common.logTime" />
          </ButtonFace>
        )
      }
      summary={<FaceLabelPending className="w-16" />}
    >
      <PersonalTimesheetEntries>
        <PersonalTimesheetEntrySkeleton />
        <PersonalTimesheetEntrySkeleton />
        <PersonalTimesheetEntrySkeleton />
      </PersonalTimesheetEntries>
    </PersonalTimesheetDayLayout>
  </div>
);
