import type { ReactNode } from "react";

import { useSearch } from "@tanstack/react-router";

import { ButtonFace, FaceLabelPending } from "@stll/ui/control-face";
import { DirectionalIcon } from "@stll/ui/directional-icon";
import { ChevronLeftIcon, ChevronRightIcon } from "@stll/ui/icons";
import { ScrollArea } from "@stll/ui/scroll-area";

import { PendingText } from "@/components/pending-text";
import { framePendingView } from "@/routes/-pending-view.logic";

import { MatterApprovalSkeleton } from "./-components/billing/matter-approval-view.pending";
import { PersonalTimesheetDaySkeleton } from "./-components/billing/personal-timesheet-day.pending";

export const MatterTimesheetsShell = ({
  actions,
  children,
  dialogs,
  title,
}: {
  actions: ReactNode;
  children: ReactNode;
  dialogs?: ReactNode;
  title: ReactNode;
}) => (
  <div className="flex h-full flex-col">
    <header className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
      <h1 className="text-sm font-medium">{title}</h1>
      <div className="flex flex-wrap items-center gap-2">{actions}</div>
    </header>
    <ScrollArea axis="vertical" className="flex-1">
      <div className="p-4">{children}</div>
    </ScrollArea>
    {dialogs}
  </div>
);

export const TimesheetDayLabel = ({ children }: { children: ReactNode }) => (
  <span className="min-w-36 text-center text-sm">{children}</span>
);

const TimesheetDayNavigationFace = () => (
  <>
    <ButtonFace size="sm" variant="outline">
      <PendingText barClassName="w-10" id="common.today" />
    </ButtonFace>
    <ButtonFace className="size-11" size="icon" variant="ghost">
      <DirectionalIcon className="size-4" icon={ChevronLeftIcon} />
    </ButtonFace>
    <TimesheetDayLabel>
      <FaceLabelPending className="w-24" />
    </TimesheetDayLabel>
    <ButtonFace className="size-11" size="icon" variant="ghost">
      <DirectionalIcon className="size-4" icon={ChevronRightIcon} />
    </ButtonFace>
  </>
);

export const MatterTimesheetsPending = framePendingView(() => {
  const view = useSearch({
    strict: false,
    select: (search) => search.view,
  });
  const approvals = view === "approvals";
  return (
    <MatterTimesheetsShell
      actions={approvals ? null : <TimesheetDayNavigationFace />}
      title={<PendingText id="billing.timesheets" />}
    >
      {approvals ? (
        <MatterApprovalSkeleton />
      ) : (
        <PersonalTimesheetDaySkeleton />
      )}
    </MatterTimesheetsShell>
  );
});
