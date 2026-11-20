import type { ReactNode } from "react";

import { ButtonFace, FaceLabelPending, InputFace } from "@stll/ui/control-face";

import { PendingText } from "@/components/pending-text";

export const TimeReviewRowLayout = ({
  actions,
  approval,
  checkbox,
  details,
}: {
  actions: ReactNode;
  approval?: ReactNode;
  checkbox?: ReactNode;
  details: ReactNode;
}) => (
  <li className="rounded-md border p-3">
    <div className="flex items-start gap-3">
      {checkbox}
      <div className="min-w-0 flex-1">{details}</div>
      {approval}
    </div>
    <div className="mt-2 flex flex-wrap items-center justify-end gap-2">
      {actions}
    </div>
  </li>
);

export const TimeReviewRowSkeleton = () => (
  <TimeReviewRowLayout
    actions={
      <>
        <InputFace className="max-w-72">
          <PendingText id="billing.approval.returnComment" />
        </InputFace>
        <ButtonFace size="sm" variant="outline">
          <PendingText id="billing.revertToDraft" />
        </ButtonFace>
      </>
    }
    approval={
      <ButtonFace size="sm" variant="default">
        <PendingText barClassName="w-12" id="billing.approve" />
      </ButtonFace>
    }
    checkbox={<span className="size-4 shrink-0 rounded-sm border" />}
    details={
      <>
        <div className="flex flex-wrap gap-x-4 text-sm tabular-nums">
          <FaceLabelPending className="w-24" />
          <FaceLabelPending className="w-12" />
          <FaceLabelPending className="w-16" />
        </div>
        <div className="mt-1 text-sm">
          <FaceLabelPending className="w-3/4" />
        </div>
      </>
    }
  />
);
