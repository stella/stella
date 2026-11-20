import type { ReactNode } from "react";

import { PendingText } from "@/components/pending-text";
import { TimeReviewRowSkeleton } from "@/features/time-review/time-review-row.pending";

export const MatterTimeApprovalLayout = ({
  actions,
  children,
  title,
}: {
  actions?: ReactNode;
  children: ReactNode;
  title: ReactNode;
}) => (
  <section className="flex flex-col gap-3">
    <div className="flex min-h-9 items-center justify-between gap-3">
      <h2 className="text-sm font-medium">{title}</h2>
      {actions}
    </div>
    {children}
  </section>
);

export const MatterTimeApprovalRows = ({
  children,
}: {
  children: ReactNode;
}) => <ul className="flex flex-col gap-3">{children}</ul>;

export const MatterApprovalSkeleton = () => (
  <div aria-hidden="true">
    <MatterTimeApprovalLayout
      title={<PendingText id="billing.approval.timeEntries" />}
    >
      <MatterTimeApprovalRows>
        <TimeReviewRowSkeleton />
        <TimeReviewRowSkeleton />
        <TimeReviewRowSkeleton />
      </MatterTimeApprovalRows>
    </MatterTimeApprovalLayout>
  </div>
);
