import { useState } from "react";

import { useQueryClient } from "@tanstack/react-query";
import { Result } from "better-result";
import { useTranslations } from "use-intl";

import { stellaToast } from "@stll/ui/toast";

import type { TranslationKey } from "@/i18n/types";
import { getAnalytics } from "@/lib/analytics/provider";
import { APIError } from "@/lib/errors/api";
import { userErrorFromThrown } from "@/lib/errors/user-safe";
import {
  createPdfSigningHandoff,
  launchPdfSigningDeepLink,
  type PdfSigningTarget,
  watchPdfSigningSession,
} from "@/lib/pdf-signing";
import {
  type PdfSigningCloseReason,
  pdfSigningStartErrorCode,
  type PdfSigningStartErrorCode,
} from "@/lib/pdf-signing.logic";
import { entityVersionsKeys } from "@/lib/workspaces/queries/entity-versions";

const START_ERROR_KEYS = {
  entity_read_only: "workspaces.files.pdfSigning.readOnlyDescription",
  pdf_signing_encrypted: "workspaces.files.pdfSigning.encryptedDescription",
  pdf_signing_not_a_file: "workspaces.files.pdfSigning.noFileDescription",
  pdf_signing_not_a_pdf: "workspaces.files.pdfSigning.notAPdfDescription",
  pdf_signing_too_large: "workspaces.files.pdfSigning.tooLargeDescription",
} as const satisfies Record<PdfSigningStartErrorCode, TranslationKey>;

const CLOSE_REASON_KEYS = {
  base_version_diverged:
    "workspaces.files.pdfSigning.cancelledBaseVersionDescription",
  certificate_rejected:
    "workspaces.files.pdfSigning.cancelledCertificateDescription",
  digest_mismatch: "workspaces.files.pdfSigning.cancelledDigestDescription",
  unsupported_platform:
    "workspaces.files.pdfSigning.cancelledPlatformDescription",
  user_cancelled: "workspaces.files.pdfSigning.cancelledUserDescription",
} as const satisfies Record<PdfSigningCloseReason, TranslationKey>;

/**
 * Sign one PDF in the desktop app: mint a handoff, hand the deep link to the
 * OS, then watch the signing session from a single toast until it settles.
 * The action stays busy for the whole exchange, because one document field
 * carries one open signing session at a time.
 */
export const useDesktopPdfSign = (target: PdfSigningTarget) => {
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

  const sign = async () => {
    if (isSigning) {
      return;
    }
    setIsSigning(true);

    const started = await Result.tryPromise(
      async () => await createPdfSigningHandoff(target),
    );
    if (Result.isError(started)) {
      setIsSigning(false);
      getAnalytics().captureError(started.error.cause);
      stellaToast.add({
        description: describeStartFailure(started.error.cause),
        title: t("workspaces.files.pdfSigning.startFailedTitle"),
        type: "error",
      });
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
      stellaToast.update(toastId, {
        description: t(
          "workspaces.files.pdfSigning.statusUnavailableDescription",
        ),
        title: t("workspaces.files.pdfSigning.statusUnavailableTitle"),
        type: "error",
      });
      return;
    }

    const outcome = watched.value;
    switch (outcome.type) {
      case "cancelled": {
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
        stellaToast.update(toastId, {
          description: t("workspaces.files.pdfSigning.expiredDescription"),
          title: t("workspaces.files.pdfSigning.expiredTitle"),
          type: "error",
        });
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
        // Workspace realtime already refreshes the panel; the explicit
        // invalidation makes the signed version show up for a client whose
        // socket is asleep.
        await queryClient.invalidateQueries({
          queryKey: entityVersionsKeys.all({
            entityId: target.entityId,
            workspaceId: target.workspaceId,
          }),
        });
        return;
      }
    }
  };

  return { isSigning, sign };
};
