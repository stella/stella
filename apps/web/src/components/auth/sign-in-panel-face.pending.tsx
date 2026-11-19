import type { ReactElement, ReactNode } from "react";

import { ButtonFace, FaceLabelPending, InputFace } from "@stll/ui/control-face";
import { TextSeparator } from "@stll/ui/separator";
import { cn } from "@stll/ui/utils";

import { PendingText } from "@/components/pending-text";
import { isAcceptInvitationRedirect } from "@/lib/redirect";

import { configuredSocialProviders } from "./sign-in-deployment.logic";
import { SIGN_IN_ENTRY_METHOD } from "./sign-in-panel.logic";
import type { SignInEntryMethod } from "./sign-in-panel.logic";

export const SIGN_IN_CREDENTIAL_INPUT_SIZE = "lg";

export const SignInPanelShell = ({
  heading,
  social,
  beforeCredentials,
  bootstrap,
  credentials,
  separator,
  alternate,
  terms,
  professionalUse,
  feedback,
  className,
}: {
  heading?: ReactNode;
  social:
    "pending" | Record<(typeof configuredSocialProviders)[number], ReactNode>;
  beforeCredentials?: ReactNode;
  bootstrap?: ReactNode;
  credentials?: ReactNode;
  separator?: ReactNode;
  alternate?: ReactNode;
  terms?: ReactNode;
  feedback?: ReactNode;
  professionalUse?: ReactNode;
  className?: string | undefined;
}) => (
  <div className={cn("flex w-full max-w-md flex-col gap-8", className)}>
    {heading}
    {configuredSocialProviders.length > 0 && (
      <div className="flex flex-col gap-3">
        {configuredSocialProviders.map((provider) => (
          <div
            className="min-h-11"
            data-auth-provider={provider}
            key={provider}
          >
            {social === "pending" ? (
              <ButtonFace
                className="w-full"
                size="lg"
                layout="wrap"
                variant="outline"
              >
                <FaceLabelPending className="w-40" />
              </ButtonFace>
            ) : (
              social[provider]
            )}
          </div>
        ))}
      </div>
    )}
    {beforeCredentials}
    {bootstrap}
    {credentials}
    {separator}
    {alternate}
    {feedback}
    {terms !== undefined && (
      <p className="text-foreground-muted text-xs">{terms}</p>
    )}
    {professionalUse !== undefined && professionalUse !== null && (
      <p className="text-foreground-muted text-xs">{professionalUse}</p>
    )}
  </div>
);

export const SignInHeading = ({
  title,
  invitation,
  invitationState = "visible",
}: {
  title: ReactNode;
  invitation?: ReactNode;
  invitationState?: "visible" | "visible-reserved" | "hidden-reserved";
}) => (
  <div className="flex flex-col gap-2">
    <h2 className="text-foreground text-3xl leading-tight font-light tracking-tight">
      {title}
    </h2>
    {invitation !== undefined && invitation !== null && (
      <p
        aria-hidden={invitationState === "hidden-reserved" || undefined}
        className={cn(
          "text-muted-foreground text-sm",
          invitationState !== "visible" && "min-h-10 max-sm:min-h-15",
          invitationState === "hidden-reserved" && "invisible",
        )}
      >
        {invitation}
      </p>
    )}
  </div>
);

// The bootstrap form has a 12px gap after its divider; other layouts use the panel gap.
export const SignInEmailDivider = ({
  children,
}: {
  children: ReactElement | string | false;
}) => (
  <div
    className={cn("min-h-4", configuredSocialProviders.length === 0 && "-mb-5")}
  >
    {children !== false && <TextSeparator>{children}</TextSeparator>}
  </div>
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
  reserveInvitationHint = false,
  showHeading = true,
}: {
  className?: string | undefined;
  entryMethod?: SignInEntryMethod | undefined;
  redirectTo?: string;
  reserveInvitationHint?: boolean | undefined;
  showHeading?: boolean;
}) => {
  const password = entryMethod === SIGN_IN_ENTRY_METHOD.password;

  return (
    <SignInPanelShell
      className={className}
      social="pending"
      heading={
        showHeading && (
          <SignInHeading
            title={<PendingText id="auth.signIn" barClassName="w-24" />}
            invitationState={
              reserveInvitationHint ? "hidden-reserved" : "visible"
            }
            invitation={
              reserveInvitationHint ||
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
      beforeCredentials={
        <SignInEmailDivider>
          {configuredSocialProviders.length > 0 && (
            <FaceLabelPending className="w-28" />
          )}
        </SignInEmailDivider>
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
