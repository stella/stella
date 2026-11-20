import type { PropsWithChildren, ReactNode } from "react";

import { ButtonFace, FaceLabelPending } from "@stll/ui/control-face";
import {
  Frame,
  FrameDescription,
  FrameHeader,
  FramePanel,
} from "@stll/ui/frame";
import { cn } from "@stll/ui/utils";

import { InboxQuickJumpPending } from "@/components/auth/inbox-quick-jump-face";
import { OTPEmailText } from "@/components/auth/otp-panel-text";
import { PendingText, useIntlMounted } from "@/components/pending-text";

import {
  AuthCodeActionRow,
  AuthCodeVerificationPending,
} from "./code-verification-face.pending";

export const OTPPanelFrame = ({
  children,
  className,
}: PropsWithChildren<{ className?: string | undefined }>) => (
  <Frame className={cn("@container/otp-panel w-full max-w-md", className)}>
    {children}
  </Frame>
);

export const OTPProfessionalUseStatement = ({
  children,
}: PropsWithChildren) => (
  <p className="text-foreground-muted px-6 pt-6 text-xs">
    <span className="block min-h-[3lh] @max-[22rem]/otp-panel:min-h-[4lh] @max-[18rem]/otp-panel:min-h-[5lh]">
      {children}
    </span>
  </p>
);

export const OTPPanelLayout = ({
  code,
  description,
  inbox,
  isBare,
  resend,
}: {
  code: ReactNode;
  description: ReactNode;
  inbox: ReactNode;
  isBare: boolean;
  resend: ReactNode;
}) => {
  const header = (
    <>
      <FrameDescription>{description}</FrameDescription>
      <div className="mt-2">{inbox}</div>
    </>
  );

  const body = (
    <>
      {code}
      <AuthCodeActionRow>{resend}</AuthCodeActionRow>
    </>
  );

  return isBare ? (
    <div className="flex flex-col gap-5">
      <div>{header}</div>
      <div>{body}</div>
    </div>
  ) : (
    <>
      <FrameHeader>{header}</FrameHeader>
      <FramePanel>{body}</FramePanel>
    </>
  );
};

export const OTPPanelPendingContent = ({ email }: { email: string }) => {
  const intlMounted = useIntlMounted();
  return (
    <>
      <OTPProfessionalUseStatement>
        {intlMounted ? (
          <PendingText id="auth.professionalUseStatement" />
        ) : (
          <span aria-hidden="true" className="grid">
            <FaceLabelPending className="w-full" />
            <FaceLabelPending className="w-full" />
            <FaceLabelPending className="w-3/5" />
            <span className="hidden @max-[22rem]/otp-panel:flex">
              <FaceLabelPending className="w-1/2" />
            </span>
            <span className="hidden @max-[18rem]/otp-panel:flex">
              <FaceLabelPending className="w-1/3" />
            </span>
          </span>
        )}
      </OTPProfessionalUseStatement>
      <OTPPanelLayout
        code={<AuthCodeVerificationPending />}
        description={
          <>
            {intlMounted ? (
              <OTPEmailText email={email} id="auth.weSentCodeTo" />
            ) : (
              <FaceLabelPending className="w-48 max-w-full align-top" />
            )}
            {" · "}
            <ButtonFace size="inline" variant="link">
              <PendingText barClassName="w-28" id="auth.useDifferentEmail" />
            </ButtonFace>
          </>
        }
        inbox={<InboxQuickJumpPending email={email} />}
        isBare={false}
        resend={
          <ButtonFace size="sm" variant="link">
            {intlMounted ? (
              <span>
                <OTPEmailText email={email} id="auth.resendCode" />
              </span>
            ) : (
              <FaceLabelPending className="w-52 max-w-full" />
            )}
          </ButtonFace>
        }
      />
    </>
  );
};
