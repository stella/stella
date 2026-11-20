import { useSearch } from "@tanstack/react-router";

import {
  OTPPanelFrame,
  OTPPanelPendingContent,
} from "@/components/auth/otp-panel-face.pending";
import { framePendingView } from "@/routes/-pending-view.logic";

export { OTPPanelFrame as OTPRouteShell };

const OTPPendingView = () => {
  const email = useSearch({
    strict: false,
    select: (search) => (typeof search.email === "string" ? search.email : ""),
  });
  return (
    <OTPPanelFrame>
      <OTPPanelPendingContent email={email} />
    </OTPPanelFrame>
  );
};

export const OTPPending = framePendingView(OTPPendingView);
