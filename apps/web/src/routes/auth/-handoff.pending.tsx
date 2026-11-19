import type { ReactNode } from "react";

import { ButtonFace, FaceLabelPending } from "@stll/ui/control-face";

import { PendingText } from "@/components/pending-text";
import { framePendingView } from "@/routes/-pending-view.logic";

export const HandoffShell = ({
  title,
  account,
  confirm,
  cancel,
}: {
  title: ReactNode;
  account: ReactNode;
  confirm: ReactNode;
  cancel: ReactNode;
}) => (
  <div className="flex w-full max-w-md flex-col gap-4">
    <h1 className="text-xl font-semibold">{title}</h1>
    <p>{account}</p>
    <div className="flex flex-wrap gap-2">
      {confirm}
      {cancel}
    </div>
  </div>
);

export const HandoffPending = framePendingView(() => (
  <HandoffShell
    title={<PendingText id="auth.handoffTitle" barClassName="w-48" />}
    account={<FaceLabelPending className="w-56" />}
    confirm={
      <ButtonFace size="default" variant="default">
        <PendingText id="common.confirm" barClassName="w-14" />
      </ButtonFace>
    }
    cancel={
      <ButtonFace size="default" variant="outline">
        <PendingText id="common.cancel" barClassName="w-12" />
      </ButtonFace>
    }
  />
));
