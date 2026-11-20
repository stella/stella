import { useState } from "react";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Result, TaggedError } from "better-result";
import { useTranslations } from "use-intl";

import type { SignInCodeFailureReason } from "@stll/api-contract/email-delivery";
import {
  PROFESSIONAL_USE_DISPLAYED_VERSION_FIELD,
  PROFESSIONAL_USE_STATEMENT_VERSION,
} from "@stll/api-contract/professional-use";
import { Temporal } from "@stll/time";
import { Button } from "@stll/ui/button";
import { DialogFormState } from "@stll/ui/dialog";
import { FrameDescription } from "@stll/ui/frame";
import { InputOTP, InputOTPSlot } from "@stll/ui/input-otp";
import { stellaToast } from "@stll/ui/toast";
import { cn } from "@stll/ui/utils";

import { InboxQuickJump } from "@/components/auth/inbox-quick-jump";
import { useInvalidateSession } from "@/hooks/use-invalidate-session";
import { usePulse } from "@/hooks/use-pulse";
import { updateUserResource } from "@/lib/account/update-user";
import { useAnalytics } from "@/lib/analytics/provider";
import {
  authClient,
  HTTP_TOO_MANY_REQUESTS,
  isTwoFactorRedirect,
} from "@/lib/auth-client";
import { detached } from "@/lib/detached";
import { toAuthClientError } from "@/lib/errors/auth";
import { userErrorFromThrown } from "@/lib/errors/user-safe";
import { notifyUserError } from "@/lib/errors/user-toast";
import { queryView } from "@/lib/query-view.logic";
import { COMMON_TIMEZONES } from "@/lib/timezones";
import { useQueryViewError } from "@/lib/use-query-view";

import {
  accessResetProviders,
  isSocialProvider,
  socialProviderName,
} from "./access-reset.logic";
import type { SocialProvider } from "./access-reset.logic";
import {
  AUTH_CODE_LENGTH,
  AuthCodeSlots,
  AuthCodeVerification,
} from "./code-verification-face.pending";
import { newSignInAttempt, signInAttemptHeaders } from "./email-delivery.logic";
import {
  OTPPanelFrame,
  OTPPanelLayout,
  OTPProfessionalUseStatement,
} from "./otp-panel-face.pending";
import {
  EmailDeliveryFailureText,
  OTPEmailText,
  renderEmail,
} from "./otp-panel-text";
import {
  SIGN_IN_CODE_DELIVERY_WINDOW_MS,
  signInCodeDeliveryOptions,
} from "./sign-in-code-delivery";

type OTPPanelProps = {
  className?: string;
  email: string;
  // Dev-only: the mirrored code is prefilled so sign-in does not require
  // copying it from the email. Always undefined in production.
  initialOtp?: string | undefined;
  redirectTo: string;
  surface?: "frame" | "bare";
  onUseDifferentEmail?: () => void;
  onVerified?: () => void | Promise<void>;
  linkProvider?: SocialProvider | undefined;
  /**
   * The attempt id the code request that opened this panel carried. While
   * the code can be used, the panel asks whether that request's own code
   * mail bounced, and if so explains why instead of saying a code was sent.
   */
  signInAttempt?: string | undefined;
  /**
   * A code sent again names a new attempt; the owner of `signInAttempt`
   * keeps it, so a reload or remount follows the new code's mail.
   */
  onSignInAttemptChange?: (signInAttempt: string) => void;
};

const OTP_EXPIRED_MESSAGE = "OTP expired";

type VerifyOtpError = {
  status?: number | undefined;
  message?: string | undefined;
};

// Thrown instead of the raw signIn error once its toast has already been
// shown, so `onError` below can tell "already surfaced" apart from an
// unreported failure (network drop, session-refresh error, …) without
// blanket-skipping every AuthClientError/APIError that reaches it.
class AlreadyToastedError extends TaggedError("AlreadyToastedError")<{
  message: string;
  cause: unknown;
}> {}

export const OTPPanel = ({
  className,
  surface = "frame",
  ...props
}: OTPPanelProps) => {
  const body = <OTPPanelBody {...props} surface={surface} />;
  if (surface === "bare") {
    return <div className={cn("w-full", className)}>{body}</div>;
  }
  return <OTPPanelFrame className={className}>{body}</OTPPanelFrame>;
};

export const OTPPanelBody = ({
  email,
  initialOtp,
  redirectTo,
  surface = "frame",
  onUseDifferentEmail,
  onVerified,
  linkProvider,
  signInAttempt: initialSignInAttempt,
  onSignInAttemptChange,
}: Omit<OTPPanelProps, "className">) => {
  const t = useTranslations();
  const analytics = useAnalytics();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [otp, setOtp] = useState(initialOtp ?? "");
  const [signInAttempt, setSignInAttempt] = useState(() => ({
    attempt: initialSignInAttempt,
    pollUntil:
      Temporal.Now.instant().epochMilliseconds +
      SIGN_IN_CODE_DELIVERY_WINDOW_MS,
  }));
  const delivery = queryView(
    useQuery(signInCodeDeliveryOptions(signInAttempt)),
  );
  // The follow-up only adds an explanation; when it fails, the panel keeps
  // saying a code was sent and the failure is reported.
  useQueryViewError(delivery, "OTPPanel:delivery");
  const deliveryFailure =
    delivery.type === "items" && delivery.items.status === "failed"
      ? delivery.items.reason
      : undefined;
  const [resetConfirmation, setResetConfirmation] = useState<{
    otp: string;
    providers: string[];
  } | null>(null);
  const invalidateSession = useInvalidateSession();
  const isOtpComplete = otp.length === AUTH_CODE_LENGTH;
  const { isPulsing: isOtpPulsing, pulse: pulseOtp } = usePulse(600);

  // A closure over `t` (not a parameter) so its type is never written out:
  // annotating a parameter as `ReturnType<typeof useTranslations>` blows up
  // overload resolution against the full namespaced-key union badly enough
  // to hit TS's type-complexity ceiling (TS2590) at the call site below.
  //
  // Takes the already-converted `cause` (not the raw signIn error) for the
  // fallback branch: `userErrorFromThrown` only ever surfaces a vetted,
  // localized message, never the untrusted raw `error.message` from the
  // server response.
  const verifyErrorTitle = (error: VerifyOtpError, cause: unknown): string => {
    if (error.status === HTTP_TOO_MANY_REQUESTS) {
      return t("auth.rateLimitExceeded");
    }
    if (error.message === OTP_EXPIRED_MESSAGE) {
      return t("auth.oneTimeCodeExpired");
    }
    return userErrorFromThrown(cause, t("errors.actionFailed"));
  };

  const handleUseDifferentEmail = () => {
    if (onUseDifferentEmail) {
      onUseDifferentEmail();
      return;
    }

    detached(
      navigate({
        to: "/auth",
        search: { redirectTo },
        replace: true,
      }),
      "otp-panel.navigate",
    );
  };

  const resendOtp = useMutation({
    mutationFn: async () => {
      const attempt = newSignInAttempt();
      const { error } = await authClient.emailOtp.sendVerificationOtp({
        email,
        type: "sign-in",
        fetchOptions: { headers: signInAttemptHeaders(attempt) },
      });

      if (error) {
        notifyUserError(
          toAuthClientError(error),
          error.status === HTTP_TOO_MANY_REQUESTS
            ? t("auth.rateLimitExceeded")
            : userErrorFromThrown(
                toAuthClientError(error),
                t("errors.actionFailed"),
              ),
        );
        throw toAuthClientError(error);
      }

      setOtp("");
      // The new code's own mail is followed from now on; an earlier
      // attempt's bounce no longer describes it.
      setSignInAttempt({
        attempt,
        pollUntil:
          Temporal.Now.instant().epochMilliseconds +
          SIGN_IN_CODE_DELIVERY_WINDOW_MS,
      });
      onSignInAttemptChange?.(attempt);
      stellaToast.add({
        description: t("auth.checkSpamHint"),
        title: t("auth.codeSentAgain"),
        type: "success",
      });
    },
    onError: (error) => {
      analytics.captureError(error, {
        fingerprintKey: "OTPPanel:failure",
        scope: { type: "handler", handlerId: "OTPPanel:failure" },
      });
    },
  });

  const verifyOtp = useMutation({
    mutationFn: async ({
      email: emailArg,
      otp: otpArg,
      confirmReset,
    }: {
      email: string;
      otp: string;
      confirmReset?: true;
    }) => {
      const { data: signInData, error: signInError } = await authClient.$fetch(
        "/sign-in/email-otp",
        {
          method: "POST",
          body: {
            email: emailArg,
            otp: otpArg,
            // This panel shows the statement; a new account is
            // created accepted only when it is the current one.
            [PROFESSIONAL_USE_DISPLAYED_VERSION_FIELD]:
              PROFESSIONAL_USE_STATEMENT_VERSION,
            ...(confirmReset ? { confirmReset } : {}),
          },
        },
      );

      if (signInError) {
        const providers = accessResetProviders(signInError);
        if (providers !== null) {
          setResetConfirmation({ otp: otpArg, providers });
          return;
        }
        setResetConfirmation(null);
        setOtp("");
        const cause = toAuthClientError(signInError);
        const title = verifyErrorTitle(signInError, cause);
        notifyUserError(cause, title);
        throw new AlreadyToastedError({ message: title, cause });
      }

      setResetConfirmation(null);
      if (isTwoFactorRedirect(signInData)) {
        await invalidateSession.mutateAsync();
        await navigate({
          to: "/auth/two-factor",
          search: { redirectTo, linkProvider },
        });
        return;
      }

      authClient
        .getSession()
        .then(async ({ data: freshSession }) => {
          if (freshSession?.user.timezoneId !== "UTC") {
            return;
          }
          const browserTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
          const timezones: readonly string[] = COMMON_TIMEZONES;
          if (timezones.includes(browserTz)) {
            const updated = await updateUserResource({
              queryClient,
              input: { timezoneId: browserTz },
              owner: {
                userId: freshSession.user.id,
                organizationId:
                  freshSession.session.activeOrganizationId ?? null,
              },
            });
            if (Result.isError(updated)) {
              throw updated.error;
            }
          }
          return;
        })
        .catch((error: unknown) => {
          analytics.captureError(error, {
            fingerprintKey: "OTPPanel.mutationFn:failure",
            scope: {
              type: "handler",
              handlerId: "OTPPanel.mutationFn:failure",
            },
          });
        });

      await invalidateSession.mutateAsync();
      await onVerified?.();
    },
    onError: (error) => {
      analytics.captureError(
        AlreadyToastedError.is(error) ? error.cause : error,
        {
          fingerprintKey: "OTPPanel:failure-2",
          scope: { type: "handler", handlerId: "OTPPanel:failure-2" },
        },
      );
      // Only the structured sign-in error already toasted a message in the
      // mutationFn (marked by AlreadyToastedError); every other throw
      // reaching here — network failures, a session-refresh error from
      // invalidateSession, an onVerified failure — has never been surfaced,
      // so it always gets a toast.
      if (AlreadyToastedError.is(error)) {
        return;
      }
      notifyUserError(error, t("errors.actionFailed"));
    },
  });

  return (
    <>
      <DialogFormState
        dirty={otp !== (initialOtp ?? "")}
        onDiscard={() => setOtp(initialOtp ?? "")}
      />
      <OTPProfessionalUseStatement>
        {t("auth.professionalUseStatement")}
      </OTPProfessionalUseStatement>
      {resetConfirmation ? (
        <div className="flex flex-col gap-4 p-6">
          <FrameDescription>
            {t.rich("auth.accessReset.description", {
              identity: renderEmail,
              providers: resetConfirmation.providers
                .map((provider) => {
                  if (isSocialProvider(provider)) {
                    return socialProviderName(provider);
                  }
                  if (provider === "credential") {
                    return t("auth.password");
                  }
                  return provider;
                })
                .join(", "),
            })}
          </FrameDescription>
          <Button
            loading={verifyOtp.isPending}
            disabled={verifyOtp.isPending}
            onClick={() =>
              verifyOtp.mutate({
                email,
                otp: resetConfirmation.otp,
                confirmReset: true,
              })
            }
          >
            {t("auth.continueWithEmail")}
          </Button>
          <Button
            variant="ghost"
            disabled={verifyOtp.isPending}
            onClick={handleUseDifferentEmail}
          >
            {t("common.cancel")}
          </Button>
        </div>
      ) : (
        <OTPPanelContent
          deliveryFailure={deliveryFailure}
          email={email}
          isOtpComplete={isOtpComplete}
          isOtpPulsing={isOtpPulsing}
          isBare={surface === "bare"}
          onOtpChange={setOtp}
          onResend={() => resendOtp.mutate()}
          onSubmit={(code = otp) => {
            if (code.length !== AUTH_CODE_LENGTH) {
              pulseOtp();
              return;
            }
            verifyOtp.mutate({ email, otp: code });
          }}
          onUseDifferentEmail={handleUseDifferentEmail}
          otp={otp}
          resendPending={resendOtp.isPending}
          verifyPending={verifyOtp.isPending}
        />
      )}
    </>
  );
};

export const OTPPanelContent = ({
  deliveryFailure,
  email,
  isOtpComplete,
  isOtpPulsing,
  isBare,
  otp,
  resendPending,
  verifyPending,
  onOtpChange,
  onResend,
  onSubmit,
  onUseDifferentEmail,
}: {
  deliveryFailure?: SignInCodeFailureReason | undefined;
  email: string;
  isOtpComplete: boolean;
  isOtpPulsing: boolean;
  isBare: boolean;
  otp: string;
  resendPending: boolean;
  verifyPending: boolean;
  onOtpChange: (otp: string) => void;
  onResend: () => void;
  onSubmit: (otp?: string) => void;
  onUseDifferentEmail: () => void;
}) => {
  const t = useTranslations();

  return (
    <OTPPanelLayout
      code={
        <AuthCodeVerification
          input={
            <InputOTP
              autoFocus
              containerClassName={cn(
                "rounded-md",
                isOtpPulsing && "ring-primary ring-2",
              )}
              maxLength={AUTH_CODE_LENGTH}
              onChange={onOtpChange}
              onComplete={(code: string) => {
                onOtpChange(code);
                onSubmit(code);
              }}
              value={otp}
            >
              <AuthCodeSlots Slot={InputOTPSlot} />
            </InputOTP>
          }
          verify={
            <Button
              aria-disabled={!isOtpComplete || undefined}
              className={cn(!isOtpComplete && "cursor-not-allowed opacity-64")}
              disabled={verifyPending}
              loading={verifyPending}
              onClick={() => onSubmit()}
            >
              {t("common.verify")}
            </Button>
          }
        />
      }
      description={
        <>
          {deliveryFailure === undefined ? (
            <OTPEmailText email={email} id="auth.weSentCodeTo" />
          ) : (
            <span className="text-destructive" role="alert">
              <EmailDeliveryFailureText
                email={email}
                reason={deliveryFailure}
              />
            </span>
          )}
          {" · "}
          <Button
            disabled={verifyPending || resendPending}
            onClick={onUseDifferentEmail}
            size="inline"
            variant="link"
          >
            {t("auth.useDifferentEmail")}
          </Button>
        </>
      }
      inbox={<InboxQuickJump email={email} />}
      isBare={isBare}
      resend={
        <Button
          disabled={verifyPending || resendPending}
          loading={resendPending}
          onClick={onResend}
          size="sm"
          variant="link"
        >
          {/* Keep the label and email in one flex item so the button's gap
              does not add space before the address. */}
          <span>
            <OTPEmailText email={email} id="auth.resendCode" />
          </span>
        </Button>
      }
    />
  );
};
