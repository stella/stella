import type { ReactNode } from "react";

import { ButtonFace } from "@stll/ui/control-face";
import {
  Frame,
  FrameDescription,
  FrameHeader,
  FramePanel,
  FrameTitle,
} from "@stll/ui/frame";

import {
  AuthCodeActionRow,
  AuthCodeVerificationPending,
} from "@/components/auth/code-verification-face.pending";
import { PendingText } from "@/components/pending-text";
import { framePendingView } from "@/routes/-pending-view.logic";

export const TwoFactorRouteShell = ({
  alternate,
  description,
  title,
  verification,
}: {
  alternate: ReactNode;
  description: ReactNode;
  title: ReactNode;
  verification: ReactNode;
}) => (
  <Frame className="w-full max-w-md">
    <FrameHeader>
      <FrameTitle>{title}</FrameTitle>
      <FrameDescription>{description}</FrameDescription>
    </FrameHeader>
    <FramePanel>
      {verification}
      <AuthCodeActionRow>{alternate}</AuthCodeActionRow>
    </FramePanel>
  </Frame>
);

const TwoFactorPendingView = () => (
  <TwoFactorRouteShell
    alternate={
      <ButtonFace size="sm" variant="link">
        <PendingText barClassName="w-28" id="auth.twoFactor.useBackupCode" />
      </ButtonFace>
    }
    description={
      <PendingText
        barClassName="w-64 max-w-full"
        id="auth.twoFactor.enterAuthenticatorCode"
      />
    }
    title={<PendingText barClassName="w-40" id="auth.twoFactor.title" />}
    verification={<AuthCodeVerificationPending />}
  />
);

export const TwoFactorPending = framePendingView(TwoFactorPendingView);
