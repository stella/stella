import type { ReactNode } from "react";

import { useSearch } from "@tanstack/react-router";

import { ButtonFace, FaceLabelPending, InputFace } from "@stll/ui/control-face";
import {
  Frame,
  FrameDescription,
  FrameHeader,
  FramePanel,
  FrameTitle,
} from "@stll/ui/frame";

import { PendingText } from "@/components/pending-text";
import type { TranslationKey } from "@/i18n/types";
import { framePendingView } from "@/routes/-pending-view.logic";

type AuthErrorShellProps = {
  title: ReactNode;
  description?: ReactNode;
  panel: ReactNode;
};

export const AuthErrorShell = ({
  title,
  description,
  panel,
}: AuthErrorShellProps) => (
  <Frame className="w-full max-w-sm">
    <FrameHeader>
      <FrameTitle>{title}</FrameTitle>
      {description !== undefined && (
        <FrameDescription className="min-h-[2lh]">
          {description}
        </FrameDescription>
      )}
    </FrameHeader>
    <FramePanel>{panel}</FramePanel>
  </Frame>
);

export const RecoveryEmailFields = ({
  email,
  submit,
}: {
  email: ReactNode;
  submit: ReactNode;
}) => (
  <div className="flex w-full flex-col gap-3">
    {email}
    {submit}
  </div>
);

export const authErrorDescriptionId = (error: string | undefined) =>
  (error === "temporarily_unavailable" || error === "server_error"
    ? "auth.error.providerUnavailable"
    : "auth.error.generic") satisfies TranslationKey;

export const AuthErrorPending = framePendingView(() => {
  const error = useSearch({
    strict: false,
    shouldThrow: false,
    select: (search) => search.error,
  });

  if (error === "account_not_linked") {
    return (
      <AuthErrorShell
        title={<PendingText id="auth.signIn" barClassName="w-12" />}
        description={
          <span aria-hidden="true" className="grid">
            <FaceLabelPending className="w-full" />
            <FaceLabelPending className="w-2/3" />
          </span>
        }
        panel={
          <RecoveryEmailFields
            email={
              <InputFace>
                <PendingText id="auth.emailPlaceholder" barClassName="w-32" />
              </InputFace>
            }
            submit={
              <ButtonFace className="w-full" size="default" variant="default">
                <PendingText id="auth.continueWithEmail" barClassName="w-32" />
              </ButtonFace>
            }
          />
        }
      />
    );
  }

  return (
    <AuthErrorShell
      title={<PendingText id="auth.error.title" barClassName="w-40" />}
      description={
        <PendingText id={authErrorDescriptionId(error)} barClassName="w-44" />
      }
      panel={
        <ButtonFace className="w-full" size="default" variant="default">
          <PendingText id="common.tryAgain" barClassName="w-20" />
        </ButtonFace>
      }
    />
  );
});
