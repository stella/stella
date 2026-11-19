import type { ReactNode } from "react";

import { useSearch } from "@tanstack/react-router";

import { ButtonFace, FaceLabelPending } from "@stll/ui/control-face";
import { ScrollArea } from "@stll/ui/scroll-area";

import { WeekNavigatorFace } from "@/components/billing/week-navigator.pending";
import { PendingText } from "@/components/pending-text";
import { TimeReviewRowSkeleton } from "@/features/time-review/time-review-row.pending";
import { framePendingView } from "@/routes/-pending-view.logic";

export const TimeApprovalsShell = ({
  children,
  navigator,
  title,
}: {
  children: ReactNode;
  navigator: ReactNode;
  title: ReactNode;
}) => (
  <div className="flex h-full flex-col">
    <header className="flex min-h-12 flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b px-4 py-1.5">
      <h1 className="text-sm font-medium">{title}</h1>
      {navigator}
    </header>
    <ScrollArea axis="vertical" className="flex-1">
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-6 p-4">
        {children}
      </div>
    </ScrollArea>
  </div>
);

export const TimeApprovalFilters = ({ children }: { children: ReactNode }) => (
  <div className="flex flex-col gap-2">{children}</div>
);

export const TimeApprovalFilterFaces = () => (
  <TimeApprovalFilters>
    <div className="flex flex-wrap gap-1">
      <ButtonFace size="sm" variant="secondary">
        <PendingText id="billing.approval.everyone" />
      </ButtonFace>
      <ButtonFace size="sm" variant="ghost">
        <FaceLabelPending className="w-20" />
      </ButtonFace>
    </div>
    <div className="flex flex-wrap gap-1">
      <ButtonFace size="sm" variant="secondary">
        <PendingText id="inspector.matterPicker.allMatters" />
      </ButtonFace>
      <ButtonFace size="sm" variant="ghost">
        <FaceLabelPending className="w-24" />
      </ButtonFace>
    </div>
  </TimeApprovalFilters>
);

export const TimeApprovalPerson = ({
  children,
  label,
}: {
  children: ReactNode;
  label?: string | undefined;
}) => (
  <section aria-label={label} className="flex flex-col gap-3">
    {children}
  </section>
);

export const TimeApprovalPersonHeader = ({
  summary,
  actions,
}: {
  summary: ReactNode;
  actions: ReactNode;
}) => (
  <div className="flex flex-wrap items-center justify-between gap-3">
    <div className="min-w-0">{summary}</div>
    <div className="flex flex-wrap items-center justify-end gap-2">
      {actions}
    </div>
  </div>
);

export const TimeApprovalDay = ({
  date,
  children,
}: {
  date: ReactNode;
  children: ReactNode;
}) => (
  <div className="flex flex-col gap-2">
    <h3 className="text-muted-foreground text-xs font-medium">{date}</h3>
    <ul className="flex flex-col gap-2">{children}</ul>
  </div>
);

export const TimeApprovalPeopleSkeleton = () => (
  <div aria-hidden="true">
    <TimeApprovalPerson>
      <TimeApprovalPersonHeader
        actions={
          <ButtonFace size="sm" variant="default">
            <FaceLabelPending className="w-24" />
          </ButtonFace>
        }
        summary={
          <>
            <div className="text-sm font-medium">
              <FaceLabelPending className="w-28" />
            </div>
            <div className="text-xs">
              <FaceLabelPending className="w-36" />
            </div>
          </>
        }
      />
      <TimeApprovalDay date={<FaceLabelPending className="w-16" />}>
        <TimeReviewRowSkeleton />
        <TimeReviewRowSkeleton />
        <TimeReviewRowSkeleton />
      </TimeApprovalDay>
    </TimeApprovalPerson>
  </div>
);

export const TimeApprovalsPending = framePendingView(() => {
  const date = useSearch({
    strict: false,
    select: (search) => search.date,
  });
  return (
    <TimeApprovalsShell
      navigator={<WeekNavigatorFace date={date} />}
      title={<PendingText id="billing.approval.title" />}
    >
      <TimeApprovalFilterFaces />
      <TimeApprovalPeopleSkeleton />
    </TimeApprovalsShell>
  );
});
