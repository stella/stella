import { useState } from "react";

import {
  useMutation,
  useQuery,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";
import { panic } from "better-result";
import { renderSVG } from "uqr";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/components/button";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "@stll/ui/components/dialog";
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
import { stellaToast } from "@stll/ui/components/toast";

import { useAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import { authClient, isTwoFactorEnabledUser } from "@/lib/auth";
import { toAPIError } from "@/lib/errors/api";
import { toAuthClientError } from "@/lib/errors/auth";
import { sessionOptions } from "@/routes/-queries";

const TOTP_LENGTH = 6;
const BACKUP_CODES_FILE_NAME = "stella-backup-codes.txt";
const ENABLE_TWO_FACTOR_QUERY_KEY = ["auth", "two-factor", "enable"] as const;

export const TwoFactorCard = () => {
  const t = useTranslations();
  const { data: session } = useSuspenseQuery(sessionOptions);
  const enabled = isTwoFactorEnabledUser(session?.user);
  const [isEnableOpen, setIsEnableOpen] = useState(false);
  const [isDisableOpen, setIsDisableOpen] = useState(false);
  const [isRegenerateOpen, setIsRegenerateOpen] = useState(false);

  return (
    <Frame>
      <FrameHeader>
        <FrameTitle>{t("settings.account.twoFactor.title")}</FrameTitle>
        <FrameDescription>
          {t("settings.account.twoFactor.description")}
        </FrameDescription>
      </FrameHeader>
      <FramePanel>
        <div className="flex items-center justify-between gap-4 p-4">
          <span
            className={
              enabled
                ? "bg-success/16 text-success-foreground inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium"
                : "bg-muted text-muted-foreground inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium"
            }
          >
            {enabled
              ? t("settings.account.twoFactor.enabledStatus")
              : t("settings.account.twoFactor.disabledStatus")}
          </span>
          <div className="flex gap-2">
            {enabled && (
              <Button
                onClick={() => setIsRegenerateOpen(true)}
                size="sm"
                variant="outline"
              >
                {t("settings.account.twoFactor.regenerateBackupCodes")}
              </Button>
            )}
            <Button
              onClick={() => {
                if (enabled) {
                  setIsDisableOpen(true);
                  return;
                }
                setIsEnableOpen(true);
              }}
              size="sm"
              variant={enabled ? "destructive" : "default"}
            >
              {enabled
                ? t("settings.account.twoFactor.disable")
                : t("settings.account.twoFactor.enable")}
            </Button>
          </div>
        </div>
      </FramePanel>

      <EnableTwoFactorDialog
        onOpenChange={setIsEnableOpen}
        open={isEnableOpen}
      />
      <DisableTwoFactorDialog
        onOpenChange={setIsDisableOpen}
        open={isDisableOpen}
      />
      <RegenerateBackupCodesDialog
        onOpenChange={setIsRegenerateOpen}
        open={isRegenerateOpen}
      />
    </Frame>
  );
};

/**
 * Structural narrowing for the untyped `$fetch` response of
 * `/two-factor/generate-backup-codes` (see the call site for why the typed
 * client method cannot be used). better-auth always returns
 * `{ backupCodes: string[] }` on 200; anything else is exceptional.
 */
const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((entry) => typeof entry === "string");

const extractBackupCodes = (data: unknown): string[] => {
  const backupCodes =
    typeof data === "object" && data !== null && "backupCodes" in data
      ? data.backupCodes
      : null;
  if (!isStringArray(backupCodes)) {
    panic("Unexpected response from backup code regeneration");
  }
  return backupCodes;
};

const getTotpSecret = (totpURI: string): string | null => {
  try {
    return new URL(totpURI).searchParams.get("secret");
  } catch {
    return null;
  }
};

const downloadBackupCodes = (codes: readonly string[]) => {
  const blob = new Blob([codes.join("\n")], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = BACKUP_CODES_FILE_NAME;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
};

const BackupCodesList = ({ codes }: { codes: readonly string[] }) => {
  const t = useTranslations();

  const handleCopyAll = async () => {
    try {
      await navigator.clipboard.writeText(codes.join("\n"));
      stellaToast.add({ title: t("common.copied"), type: "success" });
    } catch {
      stellaToast.add({ title: t("errors.actionFailed"), type: "error" });
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="bg-muted grid grid-cols-2 gap-x-4 gap-y-1.5 rounded-md p-3 font-mono text-sm">
        {codes.map((code) => (
          <span key={code}>{code}</span>
        ))}
      </div>
      <div className="flex gap-2">
        <Button
          onClick={() => {
            void handleCopyAll();
          }}
          size="sm"
          variant="outline"
        >
          {t("settings.account.twoFactor.copyAllCodes")}
        </Button>
        <Button
          onClick={() => downloadBackupCodes(codes)}
          size="sm"
          variant="outline"
        >
          {t("settings.account.twoFactor.downloadCodes")}
        </Button>
      </div>
    </div>
  );
};

type EnableStep = "setup" | "verify" | "codes";

const EnableTwoFactorDialog = ({
  onOpenChange,
  open,
}: {
  onOpenChange: (open: boolean) => void;
  open: boolean;
}) => {
  const t = useTranslations();
  const analytics = useAnalytics();
  const queryClient = useQueryClient();
  const [step, setStep] = useState<EnableStep>("setup");
  const [code, setCode] = useState("");

  const handleOpenChange = (nextOpen: boolean) => {
    onOpenChange(nextOpen);
    if (!nextOpen) {
      setStep("setup");
      setCode("");
      // Drop the enrollment secret once the dialog closes so the next
      // "Enable" click always starts a fresh enrollment instead of resuming
      // (or displaying) a stale one.
      queryClient.removeQueries({ queryKey: ENABLE_TWO_FACTOR_QUERY_KEY });
    }
  };

  const enableQuery = useQuery({
    queryKey: ENABLE_TWO_FACTOR_QUERY_KEY,
    queryFn: async () => {
      const { data, error } = await authClient.twoFactor.enable({});

      if (error) {
        throw toAuthClientError(error);
      }

      return data;
    },
    enabled: open,
    // `enable` rotates the TOTP secret server-side, so an automatic refetch
    // (e.g. on window focus while the user is copying the code from their
    // authenticator app) would invalidate the QR they just scanned. Pin the
    // result for the lifetime of the dialog.
    staleTime: Number.POSITIVE_INFINITY,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });

  const verifyMutation = useMutation({
    mutationFn: async (submittedCode: string) => {
      const { error } = await authClient.twoFactor.verifyTotp({
        code: submittedCode,
      });

      if (error) {
        setCode("");
        stellaToast.add({
          title:
            error.code === "INVALID_CODE"
              ? t("auth.twoFactor.invalidCode")
              : t("errors.actionFailed"),
          type: "error",
        });
        throw toAuthClientError(error);
      }
    },
    onSuccess: async () => {
      setStep("codes");
      await queryClient.invalidateQueries({
        queryKey: sessionOptions.queryKey,
      });
      stellaToast.add({
        title: t("settings.account.twoFactor.enabledSuccess"),
        type: "success",
      });
    },
    onError: (error) => {
      analytics.captureError(error);
    },
  });

  const totpURI = enableQuery.data?.totpURI ?? null;
  const backupCodes = enableQuery.data?.backupCodes ?? null;
  const secret = totpURI ? getTotpSecret(totpURI) : null;
  const qrSvg = totpURI ? renderSVG(totpURI, { pixelSize: 6 }) : null;

  return (
    <Dialog onOpenChange={handleOpenChange} open={open}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>
            {t("settings.account.twoFactor.setupTitle")}
          </DialogTitle>
          {step !== "codes" && (
            <DialogDescription>
              {step === "setup"
                ? t("settings.account.twoFactor.scanQrDescription")
                : t("settings.account.twoFactor.enterCodeToConfirm")}
            </DialogDescription>
          )}
        </DialogHeader>
        <div className="flex flex-col gap-4 px-6 pb-6">
          {step === "setup" && qrSvg && (
            <div className="flex flex-col items-center gap-3">
              {/* `qrSvg` is rendered locally by `renderSVG` (uqr) from the
                 `totpURI` our own backend just returned; it is never
                 user-controlled input. The SVG already paints its own solid
                 white/black background rect so the code stays scannable
                 regardless of the app's light/dark theme. */}
              <div
                className="rounded-md p-3"
                // safe-html: locally generated by uqr's renderSVG from our own totpURI, not user input
                dangerouslySetInnerHTML={{ __html: qrSvg }}
              />
              {secret && (
                <div className="flex flex-col items-center gap-1">
                  <span className="text-muted-foreground text-xs">
                    {t("settings.account.twoFactor.manualSetupKey")}
                  </span>
                  <code className="bg-muted rounded px-2 py-1 font-mono text-sm">
                    {secret}
                  </code>
                </div>
              )}
            </div>
          )}
          {step === "setup" && !qrSvg && enableQuery.isError && (
            <div className="flex flex-col items-center gap-3 py-2">
              <p className="text-destructive-foreground text-sm">
                {t("errors.actionFailed")}
              </p>
              <Button
                loading={enableQuery.isFetching}
                onClick={() => {
                  void enableQuery.refetch();
                }}
                variant="outline"
              >
                {t("common.retry")}
              </Button>
            </div>
          )}
          {step === "setup" && !qrSvg && !enableQuery.isError && (
            <div className="flex justify-center py-4">
              <span className="border-primary h-6 w-6 animate-spin rounded-full border-2 border-t-transparent" />
            </div>
          )}
          {step === "verify" && (
            <div className="mx-auto flex w-fit flex-col items-stretch gap-2">
              <InputOTP
                autoFocus
                maxLength={TOTP_LENGTH}
                onChange={setCode}
                onComplete={(nextCode: string) => {
                  setCode(nextCode);
                  verifyMutation.mutate(nextCode);
                }}
                value={code}
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
          )}
          {step === "codes" && backupCodes && (
            <div className="flex flex-col gap-3">
              <p className="text-sm font-medium">
                {t("settings.account.twoFactor.backupCodesTitle")}
              </p>
              <p className="text-muted-foreground text-sm">
                {t("settings.account.twoFactor.backupCodesDescription")}
              </p>
              <BackupCodesList codes={backupCodes} />
            </div>
          )}
        </div>
        <DialogFooter>
          {step === "setup" && (
            <Button
              disabled={!qrSvg}
              onClick={() => setStep("verify")}
              variant="default"
            >
              {t("common.next")}
            </Button>
          )}
          {step === "verify" && (
            <Button
              disabled={code.length !== TOTP_LENGTH || verifyMutation.isPending}
              loading={verifyMutation.isPending}
              onClick={() => verifyMutation.mutate(code)}
            >
              {t("common.verify")}
            </Button>
          )}
          {step === "codes" && (
            <Button onClick={() => handleOpenChange(false)} variant="default">
              {t("settings.account.twoFactor.backupCodesSavedConfirm")}
            </Button>
          )}
          {step !== "codes" && (
            <DialogClose render={<Button variant="ghost" />}>
              {t("common.cancel")}
            </DialogClose>
          )}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
};

type DisableStep = "confirm" | "code";

const DisableTwoFactorDialog = ({
  onOpenChange,
  open,
}: {
  onOpenChange: (open: boolean) => void;
  open: boolean;
}) => {
  const t = useTranslations();
  const analytics = useAnalytics();
  const queryClient = useQueryClient();
  const [step, setStep] = useState<DisableStep>("confirm");
  const [code, setCode] = useState("");

  const handleOpenChange = (nextOpen: boolean) => {
    onOpenChange(nextOpen);
    if (!nextOpen) {
      setStep("confirm");
      setCode("");
    }
  };

  const sendDisableOtpMutation = useMutation({
    mutationFn: async () => {
      const res = await api.me["two-factor"]["send-otp"].post();
      if (res.error) {
        throw toAPIError(res.error);
      }
    },
    onSuccess: () => {
      setStep("code");
      stellaToast.add({
        title: t("settings.account.otpSentSuccess"),
        type: "success",
      });
    },
    onError: (error) => {
      stellaToast.add({
        title: error.message || t("errors.actionFailed"),
        type: "error",
      });
      analytics.captureError(error);
    },
  });

  const disableMutation = useMutation({
    mutationFn: async (submittedCode: string) => {
      // `authClient.twoFactor.disable`'s typed body has no `otp` field (the
      // server's `before` hook validates it separately from the plugin's own
      // schema — see `requireTwoFactorManageOtp` in apps/api/src/lib/auth.ts),
      // so this calls the underlying `$fetch` directly with the raw path.
      const { error } = await authClient.$fetch("/two-factor/disable", {
        method: "POST",
        body: { otp: submittedCode },
      });

      if (error) {
        stellaToast.add({
          title: t("auth.twoFactor.invalidCode"),
          type: "error",
        });
        throw toAuthClientError(error);
      }
    },
    onSuccess: async () => {
      handleOpenChange(false);
      await queryClient.invalidateQueries({
        queryKey: sessionOptions.queryKey,
      });
      stellaToast.add({
        title: t("settings.account.twoFactor.disabledSuccess"),
        type: "success",
      });
    },
    onError: (error) => {
      setCode("");
      analytics.captureError(error);
    },
  });

  return (
    <Dialog onOpenChange={handleOpenChange} open={open}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>
            {t("settings.account.twoFactor.disableConfirmTitle")}
          </DialogTitle>
          <DialogDescription>
            {step === "confirm"
              ? t("settings.account.twoFactor.disableConfirmDescription")
              : t("settings.account.twoFactor.disableOtpDescription")}
          </DialogDescription>
        </DialogHeader>
        {step === "code" && (
          <div className="mx-auto flex w-fit flex-col items-stretch gap-2 px-6 pb-2">
            <InputOTP
              autoFocus
              maxLength={TOTP_LENGTH}
              onChange={setCode}
              onComplete={(nextCode: string) => {
                setCode(nextCode);
                disableMutation.mutate(nextCode);
              }}
              value={code}
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
        )}
        <DialogFooter>
          <DialogClose render={<Button variant="ghost" />}>
            {t("common.cancel")}
          </DialogClose>
          {step === "confirm" && (
            <Button
              loading={sendDisableOtpMutation.isPending}
              onClick={() => sendDisableOtpMutation.mutate()}
              variant="destructive"
            >
              {t("settings.account.twoFactor.disable")}
            </Button>
          )}
          {step === "code" && (
            <Button
              disabled={
                code.length !== TOTP_LENGTH || disableMutation.isPending
              }
              loading={disableMutation.isPending}
              onClick={() => disableMutation.mutate(code)}
              variant="destructive"
            >
              {t("common.verify")}
            </Button>
          )}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
};

type RegenerateStep = "confirm" | "code" | "codes";

const RegenerateBackupCodesDialog = ({
  onOpenChange,
  open,
}: {
  onOpenChange: (open: boolean) => void;
  open: boolean;
}) => {
  const t = useTranslations();
  const analytics = useAnalytics();
  const [step, setStep] = useState<RegenerateStep>("confirm");
  const [code, setCode] = useState("");
  const [codes, setCodes] = useState<string[] | null>(null);

  const handleOpenChange = (nextOpen: boolean) => {
    onOpenChange(nextOpen);
    if (!nextOpen) {
      setStep("confirm");
      setCode("");
      setCodes(null);
    }
  };

  const sendOtpMutation = useMutation({
    mutationFn: async () => {
      const res = await api.me["two-factor"]["send-otp"].post();
      if (res.error) {
        throw toAPIError(res.error);
      }
    },
    onSuccess: () => {
      setStep("code");
      stellaToast.add({
        title: t("settings.account.otpSentSuccess"),
        type: "success",
      });
    },
    onError: (error) => {
      stellaToast.add({
        title: error.message || t("errors.actionFailed"),
        type: "error",
      });
      analytics.captureError(error);
    },
  });

  const regenerateMutation = useMutation({
    mutationFn: async (submittedCode: string) => {
      // `authClient.twoFactor.generateBackupCodes`'s typed body has no `otp`
      // field (the server's `before` hook validates it separately from the
      // plugin's own schema — see `requireTwoFactorManageOtp` in
      // apps/api/src/lib/auth.ts), so this calls the underlying `$fetch`
      // directly with the raw path and narrows the response structurally.
      const { data, error } = await authClient.$fetch(
        "/two-factor/generate-backup-codes",
        {
          method: "POST",
          body: { otp: submittedCode },
        },
      );

      if (error) {
        stellaToast.add({
          title: t("auth.twoFactor.invalidCode"),
          type: "error",
        });
        throw toAuthClientError(error);
      }

      return extractBackupCodes(data);
    },
    onSuccess: (backupCodes) => {
      setStep("codes");
      setCodes(backupCodes);
      stellaToast.add({
        title: t("settings.account.twoFactor.backupCodesRegenerated"),
        type: "success",
      });
    },
    onError: (error) => {
      setCode("");
      analytics.captureError(error);
    },
  });

  return (
    <Dialog onOpenChange={handleOpenChange} open={open}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>
            {t("settings.account.twoFactor.regenerateConfirmTitle")}
          </DialogTitle>
          {step !== "codes" && (
            <DialogDescription>
              {step === "confirm"
                ? t("settings.account.twoFactor.regenerateConfirmDescription")
                : t("settings.account.twoFactor.regenerateOtpDescription")}
            </DialogDescription>
          )}
        </DialogHeader>
        {step === "code" && (
          <div className="mx-auto flex w-fit flex-col items-stretch gap-2 px-6 pb-2">
            <InputOTP
              autoFocus
              maxLength={TOTP_LENGTH}
              onChange={setCode}
              onComplete={(nextCode: string) => {
                setCode(nextCode);
                regenerateMutation.mutate(nextCode);
              }}
              value={code}
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
        )}
        {step === "codes" && codes && (
          <div className="flex flex-col gap-3 px-6 pb-6">
            <BackupCodesList codes={codes} />
          </div>
        )}
        <DialogFooter>
          {step === "codes" ? (
            <Button onClick={() => handleOpenChange(false)}>
              {t("common.done")}
            </Button>
          ) : (
            <>
              <DialogClose render={<Button variant="ghost" />}>
                {t("common.cancel")}
              </DialogClose>
              {step === "confirm" && (
                <Button
                  loading={sendOtpMutation.isPending}
                  onClick={() => sendOtpMutation.mutate()}
                  variant="destructive"
                >
                  {t("settings.account.twoFactor.regenerateBackupCodes")}
                </Button>
              )}
              {step === "code" && (
                <Button
                  disabled={
                    code.length !== TOTP_LENGTH || regenerateMutation.isPending
                  }
                  loading={regenerateMutation.isPending}
                  onClick={() => regenerateMutation.mutate(code)}
                  variant="destructive"
                >
                  {t("common.verify")}
                </Button>
              )}
            </>
          )}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
};
