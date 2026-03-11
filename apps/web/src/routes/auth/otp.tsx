import { useState } from "react";

import { usePostHog } from "@posthog/react";
import { useMutation } from "@tanstack/react-query";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { useTranslations } from "use-intl";
import * as v from "valibot";

import { Button } from "@stella/ui/components/button";
import {
  Frame,
  FrameDescription,
  FrameHeader,
  FramePanel,
  FrameTitle,
} from "@stella/ui/components/frame";
import {
  InputOTP,
  InputOTPGroup,
  InputOTPSlot,
} from "@stella/ui/components/input-otp";
import { toastManager } from "@stella/ui/components/toast";

import { useInvalidateSession } from "@/hooks/use-invalidate-session";
import { authClient, HTTP_TOO_MANY_REQUESTS } from "@/lib/auth";
import { toAuthClientError } from "@/lib/errors";
import { captureError } from "@/lib/posthog/utils";
import { redirectToSchema } from "@/lib/redirect";
import { COMMON_TIMEZONES } from "@/lib/timezones";

const searchSchema = v.object({
  email: v.pipe(v.string(), v.email()),
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
  const { email, redirectTo } = Route.useSearch();
  const posthog = usePostHog();
  const navigate = Route.useNavigate();
  const [otp, setOtp] = useState("");
  const invalidateSession = useInvalidateSession();

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
        .catch((error) => {
          captureError(posthog, error);
        });

      await invalidateSession.mutateAsync();
      await navigate({
        to: "/auth/organization",
        search: { redirectTo },
        replace: true,
      });
    },
    onError: (error) => {
      captureError(posthog, error);
    },
  });

  return (
    <div className="flex flex-1 items-center justify-center">
      <Frame className="w-full max-w-sm">
        <FrameHeader>
          <FrameTitle>{t("auth.enterTheCode")}</FrameTitle>
          <FrameDescription>
            {t("auth.weSentCodeTo", { email })}
          </FrameDescription>
        </FrameHeader>
        <FramePanel>
          <div className="flex flex-col items-center gap-2 px-5 pb-4">
            <InputOTP autoFocus maxLength={6} onChange={setOtp} value={otp}>
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
            loading={verifyOtp.isPending}
            onClick={() => verifyOtp.mutate({ email, otp })}
          >
            {t("common.verify")}
          </Button>
        </FramePanel>
      </Frame>
    </div>
  );
}
