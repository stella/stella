import { useState } from "react";
import type { ReactNode } from "react";

import { useMutation } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { TaggedError } from "better-result";
import { useTranslations } from "use-intl";

import { BidiText } from "@stll/ui/components/bidi-text";
import { Button } from "@stll/ui/components/button";
import {
  Frame,
  FrameDescription,
  FrameHeader,
  FramePanel,
} from "@stll/ui/components/frame";
import {
  InputOTP,
  InputOTPGroup,
  InputOTPSlot,
} from "@stll/ui/components/input-otp";
import { stellaToast } from "@stll/ui/components/toast";
import { cn } from "@stll/ui/lib/utils";

import { InboxQuickJump } from "@/components/auth/inbox-quick-jump";
import { useInvalidateSession } from "@/hooks/use-invalidate-session";
import { usePulse } from "@/hooks/use-pulse";
import { useAnalytics } from "@/lib/analytics/provider";
import {
  authClient,
  HTTP_TOO_MANY_REQUESTS,
  isTwoFactorRedirect,
} from "@/lib/auth";
import { detached } from "@/lib/detached";
import { toAuthClientError } from "@/lib/errors/auth";
import { userErrorFromThrown } from "@/lib/errors/user-safe";
import { COMMON_TIMEZONES } from "@/lib/timezones";

const renderEmail = (chunks: ReactNode) => (
  <BidiText direction="ltr">{chunks}</BidiText>
);

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
};

const OTP_LENGTH = 6;
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
}>() {}

export function OTPPanel({
  className,
  email,
  initialOtp,
  redirectTo,
  surface = "frame",
  onUseDifferentEmail,
  onVerified,
}: OTPPanelProps) {
  const t = useTranslations();
  const analytics = useAnalytics();
  const navigate = useNavigate();
  const [otp, setOtp] = useState(initialOtp ?? "");
  const invalidateSession = useInvalidateSession();
  const isOtpComplete = otp.length === OTP_LENGTH;
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
      "handleUseDifferentEmail",
    );
  };

  const resendOtp = useMutation({
    mutationFn: async () => {
      const { error } = await authClient.emailOtp.sendVerificationOtp({
        email,
        type: "sign-in",
      });

      if (error) {
        stellaToast.add({
          title:
            error.status === HTTP_TOO_MANY_REQUESTS
              ? t("auth.rateLimitExceeded")
              : userErrorFromThrown(
                  toAuthClientError(error),
                  t("errors.actionFailed"),
                ),
          type: "error",
        });
        throw toAuthClientError(error);
      }

      setOtp("");
      stellaToast.add({
        description: t("auth.checkSpamHint"),
        title: t("auth.codeSentAgain"),
        type: "success",
      });
    },
    onError: (error) => {
      analytics.captureError(error);
    },
  });

  const verifyOtp = useMutation({
    mutationFn: async ({
      email: emailArg,
      otp: otpArg,
    }: {
      email: string;
      otp: string;
    }) => {
      const { data: signInData, error: signInError } =
        await authClient.signIn.emailOtp({
          email: emailArg,
          otp: otpArg,
        });

      if (signInError) {
        setOtp("");
        const cause = toAuthClientError(signInError);
        const title = verifyErrorTitle(signInError, cause);
        stellaToast.add({ title, type: "error" });
        throw new AlreadyToastedError({ message: title, cause });
      }

      if (isTwoFactorRedirect(signInData)) {
        await navigate({
          to: "/auth/two-factor",
          search: { redirectTo },
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
            await authClient.updateUser({ timezoneId: browserTz });
          }
          return;
        })
        .catch((error: unknown) => {
          analytics.captureError(error);
        });

      await invalidateSession.mutateAsync();
      await onVerified?.();
    },
    onError: (error) => {
      analytics.captureError(
        AlreadyToastedError.is(error) ? error.cause : error,
      );
      // Only the structured sign-in error already toasted a message in the
      // mutationFn (marked by AlreadyToastedError); every other throw
      // reaching here — network failures, a session-refresh error from
      // invalidateSession, an onVerified failure — has never been surfaced,
      // so it always gets a toast.
      if (AlreadyToastedError.is(error)) {
        return;
      }
      stellaToast.add({
        title: userErrorFromThrown(error, t("errors.actionFailed")),
        type: "error",
      });
    },
  });

  const panel = (
    <OTPPanelContent
      email={email}
      isOtpComplete={isOtpComplete}
      isOtpPulsing={isOtpPulsing}
      isBare={surface === "bare"}
      onOtpChange={setOtp}
      onResend={() => resendOtp.mutate()}
      onSubmit={(code = otp) => {
        if (code.length !== OTP_LENGTH) {
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
  );

  if (surface === "bare") {
    return <div className={cn("w-full", className)}>{panel}</div>;
  }

  return <Frame className={cn("w-full max-w-md", className)}>{panel}</Frame>;
}

function OTPPanelContent({
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
}) {
  const t = useTranslations();

  const header = (
    <>
      <FrameDescription>
        {t.rich("auth.weSentCodeTo", {
          email: renderEmail,
          emailAddress: email,
        })}
        {" · "}
        <Button
          className="h-auto p-0 align-baseline text-sm font-normal text-inherit underline"
          disabled={verifyPending || resendPending}
          onClick={onUseDifferentEmail}
          variant="link"
        >
          {t("auth.useDifferentEmail")}
        </Button>
      </FrameDescription>
      <div className="mt-2">
        <InboxQuickJump email={email} />
      </div>
    </>
  );

  const body = (
    <>
      <div className="mx-auto flex w-fit flex-col items-stretch gap-2">
        <InputOTP
          autoFocus
          containerClassName={cn(
            "rounded-md transition-shadow",
            isOtpPulsing && "ring-primary ring-2",
          )}
          maxLength={OTP_LENGTH}
          onChange={onOtpChange}
          onComplete={(code: string) => {
            onOtpChange(code);
            onSubmit(code);
          }}
          value={otp}
        >
          <InputOTPGroup>
            <InputOTPSlot index={0} />
            <InputOTPSlot index={1} />
            <InputOTPSlot index={2} />
            <InputOTPSlot index={3} />
            <InputOTPSlot index={4} />
            <InputOTPSlot index={5} />
          </InputOTPGroup>
        </InputOTP>
        <Button
          aria-disabled={!isOtpComplete || undefined}
          className={cn(!isOtpComplete && "cursor-not-allowed opacity-64")}
          disabled={verifyPending}
          loading={verifyPending}
          onClick={() => onSubmit()}
        >
          {t("common.verify")}
        </Button>
      </div>
      <div className="mt-3 flex justify-center">
        <Button
          disabled={verifyPending || resendPending}
          loading={resendPending}
          onClick={onResend}
          size="sm"
          variant="link"
        >
          {t.rich("auth.resendCode", {
            email: renderEmail,
            emailAddress: email,
          })}
        </Button>
      </div>
    </>
  );

  if (isBare) {
    return (
      <div className="flex flex-col gap-5">
        <div>{header}</div>
        <div>{body}</div>
      </div>
    );
  }

  return (
    <>
      <FrameHeader>{header}</FrameHeader>
      <FramePanel>{body}</FramePanel>
    </>
  );
}
