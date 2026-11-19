import { ButtonFace, FaceLabelPending } from "@stll/ui/control-face";

import { HandoffShell } from "@/components/auth/handoff-confirmation-shell.pending";
import { PendingText } from "@/components/pending-text";
import { framePendingView } from "@/routes/-pending-view.logic";

export { HandoffShell };

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
