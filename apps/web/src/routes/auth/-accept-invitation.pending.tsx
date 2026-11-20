import type { ReactNode } from "react";

import { ButtonFace, FaceLabelPending } from "@stll/ui/control-face";
import {
  Frame,
  FrameDescription,
  FrameHeader,
  FramePanel,
  FrameTitle,
} from "@stll/ui/frame";

import { PendingText } from "@/components/pending-text";
import { framePendingView } from "@/routes/-pending-view.logic";

type InvitationShellProps = {
  title: ReactNode;
  description: ReactNode;
  guidance?: ReactNode;
  primaryAction: ReactNode;
  secondaryAction: ReactNode;
};

export const InvitationShell = ({
  title,
  description,
  guidance,
  primaryAction,
  secondaryAction,
}: InvitationShellProps) => (
  <Frame className="w-full max-w-sm">
    <FrameHeader>
      <FrameTitle>{title}</FrameTitle>
      <FrameDescription className="min-h-[2lh]">{description}</FrameDescription>
    </FrameHeader>
    <FramePanel className="flex flex-col gap-4">
      {guidance}
      <div className="flex flex-col gap-2">
        {primaryAction}
        {secondaryAction}
      </div>
    </FramePanel>
  </Frame>
);

const InvitationDescriptionPending = () => (
  <span aria-hidden="true" className="grid">
    <FaceLabelPending className="w-11/12" />
    <FaceLabelPending className="w-3/5" />
  </span>
);

export const InvitationPending = framePendingView(() => (
  <InvitationShell
    title={<PendingText id="auth.invitation.title" barClassName="w-40" />}
    description={<InvitationDescriptionPending />}
    primaryAction={
      <ButtonFace className="w-full" size="default" variant="default">
        <PendingText id="common.accept" barClassName="w-11" />
      </ButtonFace>
    }
    secondaryAction={
      <ButtonFace className="w-full" size="default" variant="outline">
        <PendingText id="common.decline" barClassName="w-12" />
      </ButtonFace>
    }
  />
));
