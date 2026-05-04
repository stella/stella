import { useState } from "react";

import { Button } from "@stll/ui/components/button";
import {
  Frame,
  FrameDescription,
  FrameHeader,
  FramePanel,
  FrameTitle,
} from "@stll/ui/components/frame";
import {
  InputOTP,
  InputOTPGroup,
  InputOTPSlot,
} from "@stll/ui/components/input-otp";
import { toastManager } from "@stll/ui/components/toast";
import { useMutation } from "@tanstack/react-query";
import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { useTranslations } from "use-intl";
import * as v from "valibot";

import { useInvalidateSession } from "@/hooks/use-invalidate-session";
import { useAnalytics } from "@/lib/analytics/provider";
import { authClient, HTTP_TOO_MANY_REQUESTS } from "@/lib/auth";
import { toAuthClientError } from "@/lib/errors";
import { redirectToSchema } from "@/lib/redirect";
import { emailSchema } from "@/lib/schema";
import { COMMON_TIMEZONES } from "@/lib/timezones";

import { InboxQuickJump } from "./-components/inbox-quick-jump";

const OTP_LENGTH = 6;

const searchSchema = v.strictObject({
  email: emailSchema(),
  redirectTo: redirectToSchema,
});

export const Route = createFileRoute("/auth/otp")({
  validateSearch: searchSchema,
  beforeLoad: ({ context, search }) => {
    if (context.session) {
      throw redirect({
        to: "/auth/organization",
        search: { redirectTo: search.redirectTo },
        replace: true,
      });
    }
  },
  component: OTP,
});

function OTP() {
  const t = useTranslations();
  const { email, redirectTo } = Route.useSearch({
    select: (s) => ({ email: s.email, redirectTo: s.redirectTo }),
  });
  const analytics = useAnalytics();
  const navigate = useNavigate();
  const [otp, setOtp] = useState("");
  const invalidateSession = useInvalidateSession();
  const isOtpComplete = otp.length === OTP_LENGTH;

  const resendOtp = useMutation({
    mutationFn: async () => {
      const { error } = await authClient.emailOtp.sendVerificationOtp({
        email,
        type: "sign-in",
      });

      if (error) {
        toastManager.add({
          title:
            error.status === HTTP_TOO_MANY_REQUESTS
              ? t("auth.rateLimitExceeded")
              : (error.message ?? t("errors.actionFailed")),
          type: "error",
        });
        throw toAuthClientError(error);
      }

      setOtp("");
      toastManager.add({
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
          toastManager.add({
            title: signInError.message ?? t("errors.actionFailed"),
            type: "error",
          });
        }
        throw toAuthClientError(signInError);
      }

      // Sync browser timezone on first login (fire-and-forget).
      // Don't block the sign-in path; runs entirely in background.
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
        })
        .catch((error: unknown) => {
          analytics.captureError(error);
        });

      await invalidateSession.mutateAsync();
      await navigate({
        to: "/auth/organization",
        search: { redirectTo },
        replace: true,
      });
    },
    onError: (error) => {
      analytics.captureError(error);
    },
  });

  return (
    <Frame className="w-full max-w-sm">
      <FrameHeader>
        <FrameTitle>{t("auth.enterTheCode")}</FrameTitle>
        <FrameDescription>{t("auth.weSentCodeTo", { email })}</FrameDescription>
      </FrameHeader>
      <FramePanel>
        <div className="flex flex-col items-center gap-2 px-5 pb-4">
          <InputOTP
            autoFocus
            maxLength={OTP_LENGTH}
            onChange={setOtp}
            onComplete={(code: string) =>
              verifyOtp.mutate({ email, otp: code })
            }
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
        </div>
        <Button
          className="w-full"
          disabled={!isOtpComplete || verifyOtp.isPending}
          loading={verifyOtp.isPending}
          onClick={() => verifyOtp.mutate({ email, otp })}
        >
          {t("common.verify")}
        </Button>
        <div className="mt-3">
          <InboxQuickJump email={email} />
        </div>
        <div className="mt-3 flex flex-col gap-1">
          <Button
            className="h-auto min-h-9 w-full py-2 text-center leading-snug break-words whitespace-normal"
            disabled={verifyOtp.isPending || resendOtp.isPending}
            loading={resendOtp.isPending}
            onClick={() => resendOtp.mutate()}
            variant="ghost"
          >
            {t("auth.resendCode", { email })}
          </Button>
          <Button
            className="w-full"
            disabled={verifyOtp.isPending || resendOtp.isPending}
            onClick={() => {
              void navigate({
                to: "/auth",
                search: { redirectTo },
                replace: true,
              });
            }}
            variant="ghost"
          >
            {t("auth.useDifferentEmail")}
          </Button>
        </div>
      </FramePanel>
    </Frame>
  );
}
