import { useState } from "react";

import { useMutation } from "@tanstack/react-query";
import { Result } from "better-result";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { DialogFormState } from "@stll/ui/dialog";
import { Input } from "@stll/ui/input";
import { InputOTP, InputOTPSlot } from "@stll/ui/input-otp";
import { cn } from "@stll/ui/utils";

import {
  AUTH_CODE_LENGTH,
  AuthCodeSlots,
  AuthCodeVerification,
} from "@/components/auth/code-verification-face.pending";
import { useInvalidateSession } from "@/hooks/use-invalidate-session";
import { usePulse } from "@/hooks/use-pulse";
import { useAnalytics } from "@/lib/analytics/provider";
import { authClient, HTTP_TOO_MANY_REQUESTS } from "@/lib/auth-client";
import { toAuthClientError } from "@/lib/errors/auth";
import { transformUnknownError } from "@/lib/errors/client";
import { readQueryResult } from "@/lib/errors/query-result";
import { notifyUserError } from "@/lib/errors/user-toast";

import { TwoFactorRouteShell } from "./-two-factor.pending";

type TwoFactorMode = "totp" | "backupCode";

export function TwoFactorPage() {
  const t = useTranslations();
  const analytics = useAnalytics();
  const invalidateSession = useInvalidateSession();
  const [mode, setMode] = useState<TwoFactorMode>("totp");
  const [totp, setTotp] = useState("");
  const [backupCode, setBackupCode] = useState("");
  const { isPulsing: isTotpPulsing, pulse: pulseTotp } = usePulse(600);

  const verifyTwoFactor = useMutation({
    mutationFn: async (input: { code: string; mode: TwoFactorMode }) => {
      const { error } =
        input.mode === "totp"
          ? await authClient.twoFactor.verifyTotp({
              code: input.code,
            })
          : await authClient.twoFactor.verifyBackupCode({
              code: input.code,
            });

      if (error) {
        const failure = toAuthClientError(error);
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
          notifyUserError(failure, message);
        }
        readQueryResult(Result.err(failure));
      }

      // The redirect target's `beforeLoad` (see routes/auth/two-factor.tsx)
      // redirects away as soon as `context.session` resolves, mirroring the
      // email-OTP step (routes/auth/otp.tsx + otp-panel.tsx).
      const refreshed = await Result.tryPromise({
        try: async () => await invalidateSession.mutateAsync(),
        catch: transformUnknownError,
      });
      if (refreshed.isErr()) {
        notifyUserError(refreshed.error, t("errors.actionFailed"));
      }
      readQueryResult(refreshed);
    },
    onError: (error) => {
      analytics.captureError(error, {
        fingerprintKey: "TwoFactorPanel:failure",
        scope: { type: "handler", handlerId: "TwoFactorPanel:failure" },
      });
    },
  });

  const handleSwitchMode = (nextMode: TwoFactorMode) => {
    setMode(nextMode);
    setTotp("");
    setBackupCode("");
  };

  const isTotpComplete = totp.length === AUTH_CODE_LENGTH;
  const verification =
    mode === "totp" ? (
      <AuthCodeVerification
        input={
          <InputOTP
            autoFocus
            containerClassName={cn(
              "rounded-md",
              isTotpPulsing && "ring-primary ring-2",
            )}
            maxLength={AUTH_CODE_LENGTH}
            onChange={setTotp}
            onComplete={(code: string) => {
              setTotp(code);
              verifyTwoFactor.mutate({ code, mode: "totp" });
            }}
            value={totp}
          >
            <AuthCodeSlots Slot={InputOTPSlot} />
          </InputOTP>
        }
        verify={
          <Button
            aria-disabled={!isTotpComplete || undefined}
            className={cn(!isTotpComplete && "cursor-not-allowed opacity-64")}
            disabled={verifyTwoFactor.isPending}
            disabledReason={t("common.verifying")}
            loading={verifyTwoFactor.isPending}
            onClick={() => {
              if (!isTotpComplete) {
                pulseTotp();
                return;
              }
              verifyTwoFactor.mutate({ code: totp, mode: "totp" });
            }}
          >
            {t("common.verify")}
          </Button>
        }
      />
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
          disabledReason={t("common.verifying")}
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
    );

  return (
    <>
      <DialogFormState
        dirty={totp !== "" || backupCode !== ""}
        onDiscard={() => {
          setTotp("");
          setBackupCode("");
          setMode("totp");
        }}
      />
      <TwoFactorRouteShell
        alternate={
          <Button
            disabled={verifyTwoFactor.isPending}
            disabledReason={t("common.verifying")}
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
        }
        description={
          mode === "totp"
            ? t("auth.twoFactor.enterAuthenticatorCode")
            : t("auth.twoFactor.enterBackupCode")
        }
        title={t("auth.twoFactor.title")}
        verification={verification}
      />
    </>
  );
}
