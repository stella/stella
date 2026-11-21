import type { ReactNode } from "react";

import { ButtonFace, FaceLabelPending } from "@stll/ui/control-face";
import {
  Frame,
  FrameFooter,
  FrameHeader,
  FramePanel,
  FrameTitle,
} from "@stll/ui/frame";

import { PendingText, useIntlMounted } from "@/components/pending-text";
import { framePendingView } from "@/routes/-pending-view.logic";

type ProfessionalUseShellProps = {
  title: ReactNode;
  statement: ReactNode;
  signOut: ReactNode;
  accept: ReactNode;
};

export const ProfessionalUseShell = ({
  title,
  statement,
  signOut,
  accept,
}: ProfessionalUseShellProps) => (
  <Frame className="w-full max-w-md">
    <FrameHeader>
      <FrameTitle>{title}</FrameTitle>
    </FrameHeader>
    <FramePanel>
      <p className="text-foreground min-h-[4lh] text-sm text-pretty max-[26rem]:min-h-[5lh] max-[22.5rem]:min-h-[6lh]">
        {statement}
      </p>
    </FramePanel>
    <FrameFooter>
      <div className="flex justify-end gap-2">
        {signOut}
        {accept}
      </div>
    </FrameFooter>
  </Frame>
);

const ProfessionalUseStatementPending = () =>
  useIntlMounted() ? (
    <PendingText id="auth.professionalUseStatement" />
  ) : (
    <span aria-hidden="true" className="grid">
      <FaceLabelPending className="w-full" />
      <FaceLabelPending className="w-full" />
      <FaceLabelPending className="w-11/12" />
      <FaceLabelPending className="w-full" />
      <span className="hidden max-[26rem]:grid">
        <FaceLabelPending className="w-full" />
      </span>
      <span className="hidden max-[22.5rem]:grid">
        <FaceLabelPending className="w-full" />
      </span>
    </span>
  );

export const ProfessionalUsePending = framePendingView(() => (
  <ProfessionalUseShell
    title={<PendingText id="auth.professionalUse.title" barClassName="w-40" />}
    statement={<ProfessionalUseStatementPending />}
    signOut={
      <ButtonFace size="default" variant="ghost">
        <PendingText id="common.signOut" barClassName="w-14" />
      </ButtonFace>
    }
    accept={
      <ButtonFace size="default" variant="default">
        <PendingText id="common.accept" barClassName="w-11" />
      </ButtonFace>
    }
  />
));
