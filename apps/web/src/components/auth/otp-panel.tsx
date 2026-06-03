import { useState } from "react";

import { useMutation } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

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
import { authClient, HTTP_TOO_MANY_REQUESTS } from "@/lib/auth";
import { toAuthClientError } from "@/lib/errors";
import { COMMON_TIMEZONES } from "@/lib/timezones";

type OTPPanelProps = {
  className?: string;
  email: string;
  redirectTo: string;
  surface?: "frame" | "bare";
  onUseDifferentEmail?: () => void;
  onVerified?: () => void | Promise<void>;
};

const OTP_LENGTH = 6;
const OTP_EXPIRED_MESSAGE = "OTP expired";

export function OTPPanel({
  className,
  email,
  redirectTo,
  surface = "frame",
  onUseDifferentEmail,
  onVerified,
}: OTPPanelProps) {
  const t = useTranslations();
  const analytics = useAnalytics();
  const navigate = useNavigate();
  const [otp, setOtp] = useState("");
  const invalidateSession = useInvalidateSession();
  const isOtpComplete = otp.length === OTP_LENGTH;
  const { isPulsing: isOtpPulsing, pulse: pulseOtp } = usePulse(600);

  const handleUseDifferentEmail = () => {
    if (onUseDifferentEmail) {
      onUseDifferentEmail();
      return;
    }

    void navigate({
      to: "/auth",
      search: { redirectTo },
      replace: true,
    });
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
              : (error.message ?? t("errors.actionFailed")),
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
      const { error: signInError } = await authClient.signIn.emailOtp({
        email: emailArg,
        otp: otpArg,
      });

      if (signInError) {
        setOtp("");
        if (signInError.status !== HTTP_TOO_MANY_REQUESTS) {
          stellaToast.add({
            title:
              signInError.message === OTP_EXPIRED_MESSAGE
                ? t("auth.oneTimeCodeExpired")
                : (signInError.message ?? t("errors.actionFailed")),
            type: "error",
          });
        }
        throw toAuthClientError(signInError);
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
      analytics.captureError(error);
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
        {t("auth.weSentCodeTo", { email })}
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
          {t("auth.resendCode", { email })}
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
