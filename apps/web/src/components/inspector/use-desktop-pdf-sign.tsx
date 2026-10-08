import { useRef, useState } from "react";

import { useQueryClient } from "@tanstack/react-query";
import { panic, Result } from "better-result";
import { useTranslations } from "use-intl";

import {
  DESKTOP_HANDOFF_FAILURE,
  type DesktopHandoffFailureReason,
} from "@stll/api-contract/desktop-handoff";
import { Button } from "@stll/ui/button";
import { stellaToast } from "@stll/ui/toast";

import {
  cancelPdfSigningSession,
  createPdfSigningHandoff,
  launchPdfSigningDeepLink,
  type PdfSignableFile,
  watchPdfSigningSession,
} from "@/components/inspector/pdf-signing";
import type { PdfSigningStamp } from "@/components/inspector/pdf-signing-stamp.logic";
import {
  type PdfSigningCloseReason,
  type PdfSigningExpiryStage,
  pdfSigningFinalizedQueryKeys,
  pdfSigningStartErrorCode,
  type PdfSigningStartErrorCode,
} from "@/components/inspector/pdf-signing.logic";
import { desktopHandoffFailureToastOptions } from "@/features/desktop/desktop-handoff-failure-toast";
import type { TranslationKey } from "@/i18n/types";
import { getAnalytics } from "@/lib/analytics/provider";
import { APIError } from "@/lib/errors/api";
import { userErrorFromThrown } from "@/lib/errors/user-safe";
import { detachedUserAction, notifyUserError } from "@/lib/errors/user-toast";

const START_ERROR_KEYS = {
  entity_read_only: "workspaces.files.pdfSigning.readOnlyDescription",
  pdf_signing_base_version_changed:
    "workspaces.files.pdfSigning.cancelledBaseVersionDescription",
  pdf_signing_certified_document:
    "workspaces.files.pdfSigning.cancelledCertifiedDescription",
  pdf_signing_encrypted: "workspaces.files.pdfSigning.encryptedDescription",
  pdf_signing_in_progress: "workspaces.files.pdfSigning.inProgressDescription",
  pdf_signing_not_a_file: "workspaces.files.pdfSigning.noFileDescription",
  pdf_signing_not_a_pdf: "workspaces.files.pdfSigning.notAPdfDescription",
  pdf_signing_stamp_off_page:
    "workspaces.files.pdfSigning.stampRejectedDescription",
  pdf_signing_stamp_page_not_found:
    "workspaces.files.pdfSigning.stampRejectedDescription",
  pdf_signing_stamp_time_zone:
    "workspaces.files.pdfSigning.stampRejectedDescription",
  pdf_signing_stamp_too_large:
    "workspaces.files.pdfSigning.stampRejectedDescription",
  pdf_signing_stamp_too_small:
    "workspaces.files.pdfSigning.stampRejectedDescription",
  pdf_signing_stamp_unrenderable:
    "workspaces.files.pdfSigning.stampTextUnrenderableDescription",
  pdf_signing_too_large: "workspaces.files.pdfSigning.tooLargeDescription",
} as const satisfies Record<PdfSigningStartErrorCode, TranslationKey>;

const CLOSE_REASON_KEYS = {
  base_version_diverged:
    "workspaces.files.pdfSigning.cancelledBaseVersionDescription",
  certificate_rejected:
    "workspaces.files.pdfSigning.cancelledCertificateDescription",
  certificate_revoked:
    "workspaces.files.pdfSigning.cancelledRevokedDescription",
  certified_document:
    "workspaces.files.pdfSigning.cancelledCertifiedDescription",
  digest_mismatch: "workspaces.files.pdfSigning.cancelledDigestDescription",
  expired: "workspaces.files.pdfSigning.expiredDescription",
  signature_invalid:
    "workspaces.files.pdfSigning.cancelledSignatureDescription",
  signing_failed: "workspaces.files.pdfSigning.cancelledFailedDescription",
  stamp_overflow:
    "workspaces.files.pdfSigning.cancelledStampOverflowDescription",
  stamp_unrenderable:
    "workspaces.files.pdfSigning.cancelledStampNameDescription",
  unsupported_platform:
    "workspaces.files.pdfSigning.cancelledPlatformDescription",
  user_cancelled: "workspaces.files.pdfSigning.cancelledUserDescription",
  would_break_signatures:
    "workspaces.files.pdfSigning.cancelledWouldBreakSignaturesDescription",
} as const satisfies Record<
  Exclude<PdfSigningCloseReason, DesktopHandoffFailureReason>,
  TranslationKey
>;

/** Replaces the waiting toast's Cancel action once the exchange settles. */
const NO_ACTION = { actionProps: undefined } as const;

type TextWithActionProps = {
  actionLabel: string;
  onAction: () => void;
  text: string;
};

/** A toast offers one action button; a second choice rides in its text. */
const TextWithAction = ({
  actionLabel,
  onAction,
  text,
}: TextWithActionProps) => (
  <span className="flex flex-col items-start gap-1">
    <span>{text}</span>
    <Button onClick={onAction} size="xs" type="button" variant="link">
      {actionLabel}
    </Button>
  </span>
);

type UseDesktopPdfSignOptions = {
  /** Links stella desktop to this account, as the desktop action gate does. */
  connectDesktop: () => void;
};

export type PdfSignRequest = {
  target: PdfSignableFile;
  /** Omitting `stamp` signs without a visible mark on any page. */
  stamp?: PdfSigningStamp | undefined;
};

/**
 * Sign one PDF in the desktop app, optionally with a visible stamp: mint a
 * handoff, hand the deep link to the OS, then watch the signing session from
 * a single toast until it settles. The toast appears before the handoff is
 * minted, and the action stays busy for the whole exchange, because one
 * document field carries one open signing session at a time.
 */
export const useDesktopPdfSign = ({
  connectDesktop,
}: UseDesktopPdfSignOptions) => {
  const t = useTranslations();
  const queryClient = useQueryClient();
  const [isSigning, setIsSigning] = useState(false);
  // State lags a render behind; the ref refuses a second press at once.
  const busy = useRef(false);

  const describeStartFailure = (cause: unknown) => {
    const code = APIError.is(cause)
      ? pdfSigningStartErrorCode(cause.code)
      : null;
    if (code === null) {
      return userErrorFromThrown(cause, t("errors.actionFailed"));
    }
    return t(START_ERROR_KEYS[code]);
  };

  const notifyAlreadySigning = () => {
    stellaToast.add({
      title: t("workspaces.files.pdfSigning.alreadySigningTitle"),
      type: "info",
    });
  };

  const retryAction = (request: PdfSignRequest, toastId: string) => ({
    label: t("common.retry"),
    onClick: () => {
      stellaToast.close(toastId);
      detachedUserAction(sign(request), {
        context: "use-desktop-pdf-sign.retry",
        failureMessage: t("errors.actionFailed"),
      });
    },
  });

  type NotifyExpiredOptions = {
    retry: ReturnType<typeof retryAction>;
    stage: PdfSigningExpiryStage;
    toastId: string;
  };

  const notifyExpired = ({ retry, stage, toastId }: NotifyExpiredOptions) => {
    switch (stage) {
      // The deep link was never redeemed: the app is missing, not
      // running, or not connected to this account.
      case "handoff": {
        notifyUserError(
          undefined,
          t("workspaces.files.pdfSigning.notPickedUpTitle"),
          {
            toastId,
            action: retry,
            description: (
              <TextWithAction
                actionLabel={t("workspaces.files.desktopGate.connect")}
                onAction={connectDesktop}
                text={t("workspaces.files.pdfSigning.notPickedUpDescription")}
              />
            ),
          },
        );
        return;
      }
      case "session": {
        notifyUserError(
          undefined,
          t("workspaces.files.pdfSigning.expiredTitle"),
          {
            toastId,
            action: retry,
            description: t("workspaces.files.pdfSigning.expiredDescription"),
          },
        );
        return;
      }
      default: {
        stage satisfies never;
        panic(`Unhandled signing expiry: ${String(stage)}`);
      }
    }
  };

  const signWithToast = async (
    { stamp, target }: PdfSignRequest,
    toastId: string,
  ) => {
    const started = await Result.tryPromise(
      async () => await createPdfSigningHandoff({ ...target, stamp }),
    );
    if (Result.isError(started)) {
      getAnalytics().captureError(started.error.cause);
      notifyUserError(
        started.error,
        t("workspaces.files.pdfSigning.startFailedTitle"),
        { toastId, description: describeStartFailure(started.error.cause) },
      );
      return;
    }

    const session = {
      sessionId: started.value.sessionId,
      workspaceId: target.workspaceId,
    };
    // Set once the browser's own cancel closed the session, so the watcher's
    // later read does not describe it as cancelled in stella desktop.
    const browserCancel = { settled: false };
    const cancel = async () => {
      const snapshot = await cancelPdfSigningSession(session);
      if (snapshot.status !== "cancelled") {
        // The exchange settled first; the watcher reports how.
        return;
      }
      browserCancel.settled = true;
      stellaToast.update(toastId, {
        ...NO_ACTION,
        description: undefined,
        title: t("workspaces.files.pdfSigning.cancelledTitle"),
        type: "info",
      });
    };

    launchPdfSigningDeepLink(started.value.deepLinkUrl);
    stellaToast.update(toastId, {
      action: {
        label: t("common.cancel"),
        onClick: () => {
          detachedUserAction(cancel(), {
            context: "use-desktop-pdf-sign.cancel",
            failureMessage: t("errors.actionFailed"),
          });
        },
      },
      description: (
        <TextWithAction
          actionLabel={t("workspaces.files.pdfSigning.notOpeningConnect")}
          onAction={connectDesktop}
          text={t("workspaces.files.pdfSigning.waitingDescription")}
        />
      ),
      title: t("workspaces.files.pdfSigning.waitingTitle"),
      type: "loading",
    });

    const watched = await Result.tryPromise(
      async () =>
        await watchPdfSigningSession({
          ...session,
          expiresAt: started.value.expiresAt,
        }),
    );

    if (Result.isError(watched)) {
      getAnalytics().captureError(watched.error.cause);
      notifyUserError(
        watched.error,
        t("workspaces.files.pdfSigning.statusUnavailableTitle"),
        {
          ...NO_ACTION,
          toastId,
          description: t(
            "workspaces.files.pdfSigning.statusUnavailableDescription",
          ),
        },
      );
      return;
    }

    const outcome = watched.value;
    switch (outcome.type) {
      case "cancelled": {
        if (browserCancel.settled) {
          return;
        }
        if (outcome.closeReason === DESKTOP_HANDOFF_FAILURE.updateRequired) {
          const options = desktopHandoffFailureToastOptions(
            outcome.closeReason,
            {
              accountRequiredTitle: t(
                "workspaces.files.desktopEdit.accountRequiredTitle",
              ),
              updateRequiredTitle: t(
                "workspaces.files.desktopEdit.updateRequiredTitle",
              ),
            },
          );
          notifyUserError(undefined, options.title, {
            ...NO_ACTION,
            toastId,
            description: options.description,
          });
          return;
        }
        if (outcome.closeReason === DESKTOP_HANDOFF_FAILURE.accountRequired) {
          notifyUserError(
            undefined,
            t("workspaces.files.desktopEdit.accountRequiredTitle"),
            {
              toastId,
              action: {
                label: t("workspaces.files.desktopGate.connect"),
                onClick: connectDesktop,
              },
              description: undefined,
            },
          );
          return;
        }
        const descriptionKey =
          outcome.closeReason === null
            ? "workspaces.files.pdfSigning.cancelledDescription"
            : CLOSE_REASON_KEYS[outcome.closeReason];
        stellaToast.update(toastId, {
          ...NO_ACTION,
          description: t(descriptionKey),
          title: t("workspaces.files.pdfSigning.cancelledTitle"),
          type: "info",
        });
        return;
      }
      case "expired": {
        notifyExpired({
          retry: retryAction({ stamp, target }, toastId),
          stage: outcome.stage,
          toastId,
        });
        return;
      }
      case "finalized": {
        const { versionNumber } = outcome;
        stellaToast.update(toastId, {
          ...NO_ACTION,
          description:
            versionNumber === null
              ? t("workspaces.files.pdfSigning.signedDescriptionNoVersion")
              : t("workspaces.files.pdfSigning.signedDescription", {
                  versionNumber,
                }),
          title: t("workspaces.files.pdfSigning.signedTitle"),
          type: "success",
        });
        await Promise.all(
          pdfSigningFinalizedQueryKeys(target).map(
            async (queryKey) =>
              await queryClient.invalidateQueries({ queryKey }),
          ),
        );
        return;
      }
    }
  };

  const sign = async (request: PdfSignRequest) => {
    if (busy.current) {
      notifyAlreadySigning();
      return;
    }
    busy.current = true;
    setIsSigning(true);
    // Shown before the handoff is minted: its preflight can take seconds.
    const toastId = stellaToast.add({
      description: t("workspaces.files.pdfSigning.preparingDescription"),
      title: t("workspaces.files.pdfSigning.waitingTitle"),
      type: "loading",
    });
    const signed = await Result.tryPromise(
      async () => await signWithToast(request, toastId),
    );
    busy.current = false;
    setIsSigning(false);
    if (Result.isError(signed)) {
      getAnalytics().captureError(signed.error.cause);
      notifyUserError(signed.error, t("errors.actionFailed"), {
        ...NO_ACTION,
        toastId,
      });
    }
  };

  return { isSigning, notifyAlreadySigning, sign };
};
