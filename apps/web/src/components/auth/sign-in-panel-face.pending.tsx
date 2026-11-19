import type { ReactNode } from "react";

import { ButtonFace, FaceLabelPending, InputFace } from "@stll/ui/control-face";
import { TextSeparator } from "@stll/ui/separator";
import { cn } from "@stll/ui/utils";

import { PendingText } from "@/components/pending-text";
import { isAcceptInvitationRedirect } from "@/lib/redirect";

import { socialProviderFlags } from "./sign-in-deployment.logic";
import { SIGN_IN_ENTRY_METHOD } from "./sign-in-panel.logic";
import type { SignInEntryMethod } from "./sign-in-panel.logic";

export const SIGN_IN_CREDENTIAL_INPUT_SIZE = "lg";

export const SignInPanelShell = ({
  heading,
  social,
  bootstrap,
  credentials,
  separator,
  alternate,
  terms,
  professionalUse,
  className,
}: {
  heading?: ReactNode;
  social?: ReactNode;
  bootstrap?: ReactNode;
  credentials?: ReactNode;
  separator?: ReactNode;
  alternate?: ReactNode;
  terms: ReactNode;
  professionalUse?: ReactNode;
  className?: string | undefined;
}) => (
  <div className={cn("flex w-full max-w-md flex-col gap-8", className)}>
    {heading}
    {social}
    {bootstrap}
    {credentials}
    {separator}
    {alternate}
    <p className="text-foreground-muted text-xs">{terms}</p>
    {professionalUse !== undefined && professionalUse !== null && (
      <p className="text-foreground-muted text-xs">{professionalUse}</p>
    )}
  </div>
);

export const SignInHeading = ({
  title,
  invitation,
}: {
  title: ReactNode;
  invitation?: ReactNode;
}) => (
  <div className="flex flex-col gap-2">
    <h2 className="text-foreground text-3xl leading-tight font-light tracking-tight">
      {title}
    </h2>
    {invitation !== undefined && invitation !== null && (
      <p className="text-muted-foreground text-sm">{invitation}</p>
    )}
  </div>
);

export const SignInSocialGroup = ({ children }: { children: ReactNode }) => (
  <div className="flex flex-col gap-3">{children}</div>
);

export const SignInMethodSwitch = ({ children }: { children: ReactNode }) => (
  <div className="flex justify-center">{children}</div>
);

const SignInCredentialsPending = ({ type }: { type: "code" | "password" }) => (
  <div className="flex w-full flex-col gap-4">
    <InputFace size={SIGN_IN_CREDENTIAL_INPUT_SIZE}>
      <FaceLabelPending className="w-32" />
    </InputFace>
    {type === "password" && (
      <InputFace size={SIGN_IN_CREDENTIAL_INPUT_SIZE}>
        <FaceLabelPending className="w-20" />
      </InputFace>
    )}
    <ButtonFace size="default" variant="default" className="w-full">
      <FaceLabelPending className="w-36" />
    </ButtonFace>
  </div>
);

export const SignInPanelPending = ({
  className,
  entryMethod,
  redirectTo = "/",
  showHeading = true,
}: {
  className?: string | undefined;
  entryMethod?: SignInEntryMethod | undefined;
  redirectTo?: string;
  showHeading?: boolean;
}) => {
  // The API decides which methods can sign in. Before it responds, the build
  // flags and a requested password step only determine which space to reserve.
  const socialProviders = Object.entries(socialProviderFlags).filter(
    ([, enabled]) => enabled,
  );
  const password = entryMethod === SIGN_IN_ENTRY_METHOD.password;

  return (
    <SignInPanelShell
      className={className}
      heading={
        showHeading && (
          <SignInHeading
            title={<PendingText id="auth.signIn" barClassName="w-24" />}
            invitation={
              isAcceptInvitationRedirect(redirectTo) ? (
                <PendingText
                  id="auth.signInBeforeInvitation"
                  barClassName="w-52"
                />
              ) : undefined
            }
          />
        )
      }
      social={
        socialProviders.length > 0 && (
          <SignInSocialGroup>
            {socialProviders.map(([provider]) => (
              <ButtonFace
                className="w-full"
                key={provider}
                layout="wrap"
                size="lg"
                variant="outline"
              >
                <FaceLabelPending className="w-40" />
              </ButtonFace>
            ))}
          </SignInSocialGroup>
        )
      }
      separator={
        socialProviders.length > 0 && (
          <TextSeparator>
            <PendingText id="auth.orSignInWithEmail" barClassName="w-28" />
          </TextSeparator>
        )
      }
      alternate={
        <>
          <SignInCredentialsPending type={password ? "password" : "code"} />
          {password && (
            <SignInMethodSwitch>
              <ButtonFace size="sm" variant="link">
                <FaceLabelPending className="w-24" />
              </ButtonFace>
            </SignInMethodSwitch>
          )}
        </>
      }
      terms={<FaceLabelPending className="w-56" />}
      professionalUse={
        <PendingText id="auth.professionalUseStatement" barClassName="w-56" />
      }
    />
  );
};
