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
import { Input } from "@stll/ui/components/input";
import {
  InputOTP,
  InputOTPGroup,
  InputOTPSlot,
} from "@stll/ui/components/input-otp";
import { stellaToast } from "@stll/ui/components/toast";

import { useAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import {
  authClient,
  HTTP_TOO_MANY_REQUESTS,
  isTwoFactorEnabledUser,
} from "@/lib/auth";
import { detached } from "@/lib/detached";
import { toAPIError } from "@/lib/errors/api";
import { toAuthClientError } from "@/lib/errors/auth";
import { sessionOptions } from "@/routes/-queries";

const TOTP_LENGTH = 6;
const HTTP_BAD_REQUEST = 400;
const BACKUP_CODES_FILE_NAME = "stella-backup-codes.txt";
const ENABLE_TWO_FACTOR_QUERY_KEY = ["auth", "two-factor", "enable"] as const;
const ACCOUNTS_QUERY_KEY = ["auth", "accounts"] as const;

export const TwoFactorCard = () => {
  const t = useTranslations();
  const { data: session } = useSuspenseQuery(sessionOptions);
  const enabled = isTwoFactorEnabledUser(session?.user);
  const [isEnableOpen, setIsEnableOpen] = useState(false);
  const [isDisableOpen, setIsDisableOpen] = useState(false);
  const [isRegenerateOpen, setIsRegenerateOpen] = useState(false);

  // Better Auth still requires the account password on 2FA enable/disable/
  // backup-code management for users who have a credential (password) account
  // — `allowPasswordless` only waives it for users with no password. In this
  // app that is the self-host bootstrap admin; passwordless email-OTP users
  // have no credential account and need no password. Detect it per-user so the
  // dialogs below collect the password only when the plugin will demand it,
  // while keeping the fresh-email-OTP step-up as the gate.
  const isAnyDialogOpen = isEnableOpen || isDisableOpen || isRegenerateOpen;
  const accountsQuery = useQuery({
    queryKey: ACCOUNTS_QUERY_KEY,
    queryFn: async () => {
      const { data, error } = await authClient.listAccounts();
      if (error) {
        throw toAuthClientError(error);
      }
      return data;
    },
    staleTime: 5 * 60 * 1000,
    // Account-type detection is only needed once a management dialog opens;
    // fetching lazily keeps the settings routes' network manifest unchanged.
    enabled: isAnyDialogOpen,
  });
  // `undefined` while the lazily-fetched account list is still unresolved (a
  // dialog was just opened). The three dialogs below must treat "unknown"
  // as distinct from "no password needed": starting a password-gated action
  // before the account type is known could otherwise fire the plugin call
  // without a password for a credential account.
  const requiresPassword = accountsQuery.data
    ? accountsQuery.data.some((account) => account.providerId === "credential")
    : undefined;

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
        requiresPassword={requiresPassword}
      />
      <DisableTwoFactorDialog
        onOpenChange={setIsDisableOpen}
        open={isDisableOpen}
        requiresPassword={requiresPassword}
      />
      <RegenerateBackupCodesDialog
        onOpenChange={setIsRegenerateOpen}
        open={isRegenerateOpen}
        requiresPassword={requiresPassword}
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

/**
 * Toasts the right message for a failed 2FA management call. Only a rejected
 * OTP (the gate's `400`) reads as "invalid code"; rate limits are already
 * surfaced by the auth client's shared `429` handler, and any other failure
 * (e.g. a `500`) shows its converted message instead of a misleading
 * invalid-code toast.
 *
 * Takes the already-resolved `invalidCodeMessage` string rather than the
 * `useTranslations` function: typing a `t` parameter as
 * `ReturnType<typeof useTranslations>` forces the full translation-key union to
 * instantiate at every call site here, which trips TS2590 (union too complex).
 */
const showManagementMutationError = (
  error: Parameters<typeof toAuthClientError>[0],
  invalidCodeMessage: string,
): void => {
  if (error.status === HTTP_TOO_MANY_REQUESTS) {
    return;
  }
  stellaToast.add({
    title:
      error.status === HTTP_BAD_REQUEST
        ? invalidCodeMessage
        : toAuthClientError(error).message,
    type: "error",
  });
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
            detached(handleCopyAll(), "BackupCodesList");
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
  requiresPassword,
}: {
  onOpenChange: (open: boolean) => void;
  open: boolean;
  // `undefined` until the account-type lookup resolves; enrollment must not
  // start until it is known whether a password is required (see the parent's
  // comment on `requiresPassword`).
  requiresPassword: boolean | undefined;
}) => {
  const t = useTranslations();
  const analytics = useAnalytics();
  const queryClient = useQueryClient();
  const [step, setStep] = useState<EnableStep>("setup");
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  // Credential users must submit their password before the enable call runs,
  // so the TOTP secret/QR is not generated until they do.
  const [passwordSubmitted, setPasswordSubmitted] = useState(false);

  const handleOpenChange = (nextOpen: boolean) => {
    onOpenChange(nextOpen);
    if (!nextOpen) {
      setStep("setup");
      setCode("");
      setPassword("");
      setPasswordSubmitted(false);
      // Drop the enrollment secret once the dialog closes so the next
      // "Enable" click always starts a fresh enrollment instead of resuming
      // (or displaying) a stale one.
      queryClient.removeQueries({ queryKey: ENABLE_TWO_FACTOR_QUERY_KEY });
    }
  };

  // eslint-disable-next-line @tanstack/query/exhaustive-deps -- requiresPassword/password intentionally excluded from the key: enrollment must stay pinned to one cache entry per dialog lifetime (see staleTime below), and putting the password in the cache key would leak it into the query cache/devtools. Re-runs are driven explicitly by `enabled` and `submitPassword`'s `refetch()`, not by key identity.
  const enableQuery = useQuery({
    queryKey: ENABLE_TWO_FACTOR_QUERY_KEY,
    queryFn: async () => {
      // Better Auth requires the password for credential accounts; omit it for
      // passwordless users (sending an empty one would be rejected).
      const { data, error } = await authClient.twoFactor.enable(
        requiresPassword ? { password } : {},
      );

      if (error) {
        throw toAuthClientError(error);
      }

      return data;
    },
    // Passwordless users generate the QR as soon as the dialog opens; credential
    // users only after they submit their password. Neither can happen until
    // the account type itself is known (`requiresPassword !== undefined`),
    // otherwise a credential account's enrollment could fire without a
    // password before the lazy account-type lookup resolves.
    enabled:
      open &&
      requiresPassword !== undefined &&
      (!requiresPassword || passwordSubmitted),
    // `enable` rotates the TOTP secret server-side, so an automatic refetch
    // (e.g. on window focus while the user is copying the code from their
    // authenticator app) would invalidate the QR they just scanned. Pin the
    // result for the lifetime of the dialog. `retry: false` overrides the
    // query client's default retries so a transient failure cannot silently
    // rotate the secret again behind the QR the user is looking at.
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
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

  // Show the password gate (credential users only) until enrollment succeeds.
  const showPasswordGate = requiresPassword === true && !enableQuery.data;

  const submitPassword = () => {
    if (!passwordSubmitted) {
      // First submit enables the query, which auto-runs with the password.
      setPasswordSubmitted(true);
      return;
    }
    // A later submit (e.g. after a wrong password) re-runs with the new value.
    detached(enableQuery.refetch(), "submitPassword");
  };

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
          {step === "setup" && showPasswordGate && !enableQuery.isFetching && (
            <div className="flex flex-col gap-2">
              <Input
                autoComplete="current-password"
                autoFocus
                onChange={(e) => setPassword(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && password.length > 0) {
                    e.preventDefault();
                    submitPassword();
                  }
                }}
                placeholder={t("auth.password")}
                type="password"
                value={password}
              />
              {enableQuery.isError && (
                <p className="text-destructive-foreground text-sm">
                  {t("errors.actionFailed")}
                </p>
              )}
            </div>
          )}
          {step === "setup" && !showPasswordGate && qrSvg && (
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
          {step === "setup" &&
            !showPasswordGate &&
            !qrSvg &&
            !enableQuery.isFetching &&
            enableQuery.isError && (
              <div className="flex flex-col items-center gap-3 py-2">
                <p className="text-destructive-foreground text-sm">
                  {t("errors.actionFailed")}
                </p>
                <Button
                  loading={enableQuery.isFetching}
                  onClick={() => {
                    detached(enableQuery.refetch(), "EnableTwoFactorDialog");
                  }}
                  variant="outline"
                >
                  {t("common.retry")}
                </Button>
              </div>
            )}
          {step === "setup" &&
            (enableQuery.isFetching ||
              (!showPasswordGate && !qrSvg && !enableQuery.isError)) && (
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
          {step === "setup" && showPasswordGate && (
            <Button
              disabled={password.length === 0 || enableQuery.isFetching}
              loading={enableQuery.isFetching}
              onClick={submitPassword}
              variant="default"
            >
              {t("common.next")}
            </Button>
          )}
          {step === "setup" && !showPasswordGate && (
            <Button
              disabled={!qrSvg || requiresPassword === undefined}
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
  requiresPassword,
}: {
  onOpenChange: (open: boolean) => void;
  open: boolean;
  // `undefined` until the account-type lookup resolves; see the parent's
  // comment on `requiresPassword`.
  requiresPassword: boolean | undefined;
}) => {
  const t = useTranslations();
  const analytics = useAnalytics();
  const queryClient = useQueryClient();
  const [step, setStep] = useState<DisableStep>("confirm");
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");

  const handleOpenChange = (nextOpen: boolean) => {
    onOpenChange(nextOpen);
    if (!nextOpen) {
      setStep("confirm");
      setCode("");
      setPassword("");
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
    mutationFn: async ({
      code: submittedCode,
      password: submittedPassword,
    }: {
      code: string;
      password: string;
    }) => {
      // `authClient.twoFactor.disable`'s typed body has no `otp` field (the
      // server's `before` hook validates it separately from the plugin's own
      // schema — see `requireTwoFactorManageOtp` in apps/api/src/lib/auth.ts),
      // so this calls the underlying `$fetch` directly with the raw path.
      // Better Auth's own `disable` endpoint additionally requires the
      // account password for credential accounts (see `shouldRequirePassword`
      // in node_modules/better-auth/dist/utils/password.mjs); omit it for
      // passwordless users, mirroring the enable dialog.
      const { error } = await authClient.$fetch("/two-factor/disable", {
        method: "POST",
        body: requiresPassword
          ? { otp: submittedCode, password: submittedPassword }
          : { otp: submittedCode },
      });

      if (error) {
        showManagementMutationError(error, t("auth.twoFactor.invalidCode"));
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
        {step === "confirm" && requiresPassword === true && (
          <div className="flex flex-col gap-2 px-6 pb-2">
            <Input
              autoComplete="current-password"
              autoFocus
              onChange={(e) => setPassword(e.target.value)}
              placeholder={t("auth.password")}
              type="password"
              value={password}
            />
          </div>
        )}
        {step === "code" && (
          <div className="mx-auto flex w-fit flex-col items-stretch gap-2 px-6 pb-2">
            <InputOTP
              autoFocus
              maxLength={TOTP_LENGTH}
              onChange={setCode}
              onComplete={(nextCode: string) => {
                setCode(nextCode);
                disableMutation.mutate({ code: nextCode, password });
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
              disabled={
                requiresPassword === undefined ||
                (requiresPassword && password.length === 0)
              }
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
              onClick={() => disableMutation.mutate({ code, password })}
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
  requiresPassword,
}: {
  onOpenChange: (open: boolean) => void;
  open: boolean;
  // `undefined` until the account-type lookup resolves; see the parent's
  // comment on `requiresPassword`.
  requiresPassword: boolean | undefined;
}) => {
  const t = useTranslations();
  const analytics = useAnalytics();
  const [step, setStep] = useState<RegenerateStep>("confirm");
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [codes, setCodes] = useState<string[] | null>(null);

  const handleOpenChange = (nextOpen: boolean) => {
    onOpenChange(nextOpen);
    if (!nextOpen) {
      setStep("confirm");
      setCode("");
      setPassword("");
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
    mutationFn: async ({
      code: submittedCode,
      password: submittedPassword,
    }: {
      code: string;
      password: string;
    }) => {
      // `authClient.twoFactor.generateBackupCodes`'s typed body has no `otp`
      // field (the server's `before` hook validates it separately from the
      // plugin's own schema — see `requireTwoFactorManageOtp` in
      // apps/api/src/lib/auth.ts), so this calls the underlying `$fetch`
      // directly with the raw path and narrows the response structurally.
      // Better Auth's own `generate-backup-codes` endpoint additionally
      // requires the account password for credential accounts (see
      // `shouldRequirePassword` in
      // node_modules/better-auth/dist/utils/password.mjs); omit it for
      // passwordless users, mirroring the enable and disable dialogs.
      const { data, error } = await authClient.$fetch(
        "/two-factor/generate-backup-codes",
        {
          method: "POST",
          body: requiresPassword
            ? { otp: submittedCode, password: submittedPassword }
            : { otp: submittedCode },
        },
      );

      if (error) {
        showManagementMutationError(error, t("auth.twoFactor.invalidCode"));
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
        {step === "confirm" && requiresPassword === true && (
          <div className="flex flex-col gap-2 px-6 pb-2">
            <Input
              autoComplete="current-password"
              autoFocus
              onChange={(e) => setPassword(e.target.value)}
              placeholder={t("auth.password")}
              type="password"
              value={password}
            />
          </div>
        )}
        {step === "code" && (
          <div className="mx-auto flex w-fit flex-col items-stretch gap-2 px-6 pb-2">
            <InputOTP
              autoFocus
              maxLength={TOTP_LENGTH}
              onChange={setCode}
              onComplete={(nextCode: string) => {
                setCode(nextCode);
                regenerateMutation.mutate({ code: nextCode, password });
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
                  disabled={
                    requiresPassword === undefined ||
                    (requiresPassword && password.length === 0)
                  }
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
                  onClick={() => regenerateMutation.mutate({ code, password })}
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
