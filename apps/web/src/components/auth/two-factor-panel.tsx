import { useState } from "react";

import { useMutation } from "@tanstack/react-query";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/components/button";
import { Checkbox } from "@stll/ui/components/checkbox";
import { Field, FieldLabel } from "@stll/ui/components/field";
import {
  Frame,
  FrameDescription,
  FrameHeader,
  FramePanel,
  FrameTitle,
} from "@stll/ui/components/frame";
import { Input } from "@stll/ui/components/input";
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
import { toAuthClientError } from "@/lib/errors/auth";

type TwoFactorMode = "totp" | "backupCode";

type TwoFactorPanelProps = {
  className?: string;
};

const TOTP_LENGTH = 6;

export function TwoFactorPanel({ className }: TwoFactorPanelProps) {
  const t = useTranslations();
  const analytics = useAnalytics();
  const invalidateSession = useInvalidateSession();
  const [mode, setMode] = useState<TwoFactorMode>("totp");
  const [totp, setTotp] = useState("");
  const [backupCode, setBackupCode] = useState("");
  const [trustDevice, setTrustDevice] = useState(false);
  const { isPulsing: isTotpPulsing, pulse: pulseTotp } = usePulse(600);

  const verifyTwoFactor = useMutation({
    mutationFn: async (input: { code: string; mode: TwoFactorMode }) => {
      const { error } =
        input.mode === "totp"
          ? await authClient.twoFactor.verifyTotp({
              code: input.code,
              trustDevice,
            })
          : await authClient.twoFactor.verifyBackupCode({
              code: input.code,
              trustDevice,
            });

      if (error) {
        if (input.mode === "totp") {
          setTotp("");
        } else {
          setBackupCode("");
        }
        if (error.status !== HTTP_TOO_MANY_REQUESTS) {
          let message = t("errors.actionFailed");
          if (error.code === "INVALID_CODE") {
            message = t("auth.twoFactor.invalidCode");
          } else if (error.code === "INVALID_BACKUP_CODE") {
            message = t("auth.twoFactor.invalidBackupCode");
          }
          stellaToast.add({ title: message, type: "error" });
        }
        throw toAuthClientError(error);
      }

      // The redirect target's `beforeLoad` (see routes/auth/two-factor.tsx)
      // redirects away as soon as `context.session` resolves, mirroring the
      // email-OTP step (routes/auth/otp.tsx + otp-panel.tsx).
      await invalidateSession.mutateAsync();
    },
    onError: (error) => {
      analytics.captureError(error);
    },
  });

  const handleSwitchMode = (nextMode: TwoFactorMode) => {
    setMode(nextMode);
    setTotp("");
    setBackupCode("");
  };

  return (
    <Frame className={cn("w-full max-w-md", className)}>
      <FrameHeader>
        <FrameTitle>{t("auth.twoFactor.title")}</FrameTitle>
        <FrameDescription>
          {mode === "totp"
            ? t("auth.twoFactor.enterAuthenticatorCode")
            : t("auth.twoFactor.enterBackupCode")}
        </FrameDescription>
      </FrameHeader>
      <FramePanel>
        {mode === "totp" ? (
          <div className="mx-auto flex w-fit flex-col items-stretch gap-2">
            <InputOTP
              autoFocus
              containerClassName={cn(
                "rounded-md transition-shadow",
                isTotpPulsing && "ring-primary ring-2",
              )}
              maxLength={TOTP_LENGTH}
              onChange={setTotp}
              onComplete={(code: string) => {
                setTotp(code);
                verifyTwoFactor.mutate({ code, mode: "totp" });
              }}
              value={totp}
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
              aria-disabled={totp.length !== TOTP_LENGTH || undefined}
              className={cn(
                totp.length !== TOTP_LENGTH && "cursor-not-allowed opacity-64",
              )}
              disabled={verifyTwoFactor.isPending}
              loading={verifyTwoFactor.isPending}
              onClick={() => {
                if (totp.length !== TOTP_LENGTH) {
                  pulseTotp();
                  return;
                }
                verifyTwoFactor.mutate({ code: totp, mode: "totp" });
              }}
            >
              {t("common.verify")}
            </Button>
          </div>
        ) : (
          <div className="mx-auto flex w-full max-w-xs flex-col gap-2">
            <Input
              autoFocus
              className="text-center tracking-widest"
              dir="ltr"
              onChange={(event) => setBackupCode(event.target.value.trim())}
              placeholder={t("auth.twoFactor.backupCodePlaceholder")}
              value={backupCode}
            />
            <Button
              aria-disabled={backupCode.length === 0 || undefined}
              className={cn(
                backupCode.length === 0 && "cursor-not-allowed opacity-64",
              )}
              disabled={verifyTwoFactor.isPending}
              loading={verifyTwoFactor.isPending}
              onClick={() => {
                if (backupCode.length === 0) {
                  return;
                }
                verifyTwoFactor.mutate({
                  code: backupCode,
                  mode: "backupCode",
                });
              }}
            >
              {t("common.verify")}
            </Button>
          </div>
        )}

        <Field className="mt-4 flex-row items-center gap-2">
          <Checkbox
            checked={trustDevice}
            disabled={verifyTwoFactor.isPending}
            id="two-factor-trust-device"
            onCheckedChange={setTrustDevice}
          />
          <FieldLabel htmlFor="two-factor-trust-device">
            {t("auth.twoFactor.trustDevice")}
          </FieldLabel>
        </Field>

        <div className="mt-3 flex justify-center">
          <Button
            disabled={verifyTwoFactor.isPending}
            onClick={() =>
              handleSwitchMode(mode === "totp" ? "backupCode" : "totp")
            }
            size="sm"
            variant="link"
          >
            {mode === "totp"
              ? t("auth.twoFactor.useBackupCode")
              : t("auth.twoFactor.useAuthenticatorApp")}
          </Button>
        </div>
      </FramePanel>
    </Frame>
  );
}
