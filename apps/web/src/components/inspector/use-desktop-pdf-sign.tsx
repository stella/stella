import { useState } from "react";

import { useQueryClient } from "@tanstack/react-query";
import { Result } from "better-result";
import { useTranslations } from "use-intl";

import {
  DESKTOP_HANDOFF_FAILURE,
  type DesktopHandoffFailureReason,
} from "@stll/api-contract/desktop-handoff";
import { stellaToast } from "@stll/ui/toast";

import {
  createPdfSigningHandoff,
  launchPdfSigningDeepLink,
  type PdfSignableFile,
  watchPdfSigningSession,
} from "@/components/inspector/pdf-signing";
import type { PdfSigningStamp } from "@/components/inspector/pdf-signing-stamp.logic";
import {
  type PdfSigningCloseReason,
  pdfSigningFinalizedQueryKeys,
  pdfSigningStartErrorCode,
  type PdfSigningStartErrorCode,
} from "@/components/inspector/pdf-signing.logic";
import { desktopHandoffFailureToastOptions } from "@/features/desktop/desktop-handoff-failure-toast";
import type { TranslationKey } from "@/i18n/types";
import { getAnalytics } from "@/lib/analytics/provider";
import { APIError } from "@/lib/errors/api";
import { userErrorFromThrown } from "@/lib/errors/user-safe";
import { notifyUserError } from "@/lib/errors/user-toast";

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

/**
 * Sign one PDF in the desktop app, optionally with a visible stamp: mint a
 * handoff, hand the deep link to the OS, then watch the signing session from
 * a single toast until it settles. The action stays busy for the whole
 * exchange, because one document field carries one open signing session at a
 * time.
 */
export const useDesktopPdfSign = (target: PdfSignableFile) => {
  const t = useTranslations();
  const queryClient = useQueryClient();
  const [isSigning, setIsSigning] = useState(false);

  const describeStartFailure = (cause: unknown) => {
    const code = APIError.is(cause)
      ? pdfSigningStartErrorCode(cause.code)
      : null;
    if (code === null) {
      return userErrorFromThrown(cause, t("errors.actionFailed"));
    }
    return t(START_ERROR_KEYS[code]);
  };

  const sign = async (stamp?: PdfSigningStamp) => {
    if (isSigning) {
      return;
    }
    setIsSigning(true);

    const started = await Result.tryPromise(
      async () => await createPdfSigningHandoff({ ...target, stamp }),
    );
    if (Result.isError(started)) {
      setIsSigning(false);
      getAnalytics().captureError(started.error.cause);
      notifyUserError(
        started.error,
        t("workspaces.files.pdfSigning.startFailedTitle"),
        { description: describeStartFailure(started.error.cause) },
      );
      return;
    }

    launchPdfSigningDeepLink(started.value.deepLinkUrl);
    const toastId = stellaToast.add({
      description: t("workspaces.files.pdfSigning.waitingDescription"),
      title: t("workspaces.files.pdfSigning.waitingTitle"),
      type: "loading",
    });

    const watched = await Result.tryPromise(
      async () =>
        await watchPdfSigningSession({
          expiresAt: started.value.expiresAt,
          sessionId: started.value.sessionId,
          workspaceId: target.workspaceId,
        }),
    );
    setIsSigning(false);

    if (Result.isError(watched)) {
      getAnalytics().captureError(watched.error.cause);
      notifyUserError(
        watched.error,
        t("workspaces.files.pdfSigning.statusUnavailableTitle"),
        {
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
        if (
          outcome.closeReason === DESKTOP_HANDOFF_FAILURE.updateRequired ||
          outcome.closeReason === DESKTOP_HANDOFF_FAILURE.accountRequired
        ) {
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
            toastId,
            description: options.description,
          });
          return;
        }
        const descriptionKey =
          outcome.closeReason === null
            ? "workspaces.files.pdfSigning.cancelledDescription"
            : CLOSE_REASON_KEYS[outcome.closeReason];
        stellaToast.update(toastId, {
          description: t(descriptionKey),
          title: t("workspaces.files.pdfSigning.cancelledTitle"),
          type: "info",
        });
        return;
      }
      case "expired": {
        notifyUserError(
          undefined,
          t("workspaces.files.pdfSigning.expiredTitle"),
          {
            toastId,
            description: t("workspaces.files.pdfSigning.expiredDescription"),
          },
        );
        return;
      }
      case "finalized": {
        const { versionNumber } = outcome;
        stellaToast.update(toastId, {
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

  return { isSigning, sign };
};
