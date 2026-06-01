import { useState } from "react";

import { useMutation } from "@tanstack/react-query";
import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { useTranslations } from "use-intl";
import * as v from "valibot";

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

import { useInvalidateSession } from "@/hooks/use-invalidate-session";
import { usePulse } from "@/hooks/use-pulse";
import { useAnalytics } from "@/lib/analytics/provider";
import { authClient, HTTP_TOO_MANY_REQUESTS } from "@/lib/auth";
import { toAuthClientError } from "@/lib/errors";
import { redirectToSchema } from "@/lib/redirect";
import { emailSchema } from "@/lib/schema";
import { COMMON_TIMEZONES } from "@/lib/timezones";

import { InboxQuickJump } from "./-components/inbox-quick-jump";

const OTP_LENGTH = 6;
const OTP_EXPIRED_MESSAGE = "OTP expired";

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
  const { isPulsing: isOtpPulsing, pulse: pulseOtp } = usePulse(600);

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
          return;
        })
        .catch((error: unknown) => {
          analytics.captureError(error);
        });

      // Invalidating the session re-runs this route's beforeLoad,
      // which already redirects authenticated users to
      // /auth/organization with the original redirectTo. A second
      // explicit navigate here would queue a duplicate transition
      // and flash the route's pending state twice.
      await invalidateSession.mutateAsync();
    },
    onError: (error) => {
      analytics.captureError(error);
    },
  });

  return (
    <Frame className="w-full max-w-md">
      <FrameHeader>
        <FrameDescription>
          {t("auth.weSentCodeTo", { email })}
          {" · "}
          <Button
            className="h-auto p-0 align-baseline text-sm font-normal text-inherit underline"
            disabled={verifyOtp.isPending || resendOtp.isPending}
            onClick={() => {
              void navigate({
                to: "/auth",
                search: { redirectTo },
                replace: true,
              });
            }}
            variant="link"
          >
            {t("auth.useDifferentEmail")}
          </Button>
        </FrameDescription>
        <div className="mt-2">
          <InboxQuickJump email={email} />
        </div>
      </FrameHeader>
      <FramePanel>
        <div className="mx-auto flex w-fit flex-col items-stretch gap-2">
          <InputOTP
            autoFocus
            containerClassName={cn(
              "rounded-md transition-shadow",
              isOtpPulsing && "ring-primary ring-2",
            )}
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
          <Button
            aria-disabled={!isOtpComplete || undefined}
            className={cn(!isOtpComplete && "cursor-not-allowed opacity-64")}
            disabled={verifyOtp.isPending}
            loading={verifyOtp.isPending}
            onClick={() => {
              if (!isOtpComplete) {
                pulseOtp();
                return;
              }
              verifyOtp.mutate({ email, otp });
            }}
          >
            {t("common.verify")}
          </Button>
        </div>
        <div className="mt-3 flex justify-center">
          <Button
            disabled={verifyOtp.isPending || resendOtp.isPending}
            loading={resendOtp.isPending}
            onClick={() => resendOtp.mutate()}
            size="sm"
            variant="link"
          >
            {t("auth.resendCode", { email })}
          </Button>
        </div>
      </FramePanel>
    </Frame>
  );
}
