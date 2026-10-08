import { useState } from "react";

import { useTranslations } from "use-intl";

import { getAnalytics } from "@/lib/analytics/provider";
import { externalApiOrigin } from "@/lib/api-origins";
import { getFreshLinkedAccount } from "@/lib/auth-session";
import {
  DesktopBridgeIncompatibleError,
  openFileInDesktop,
} from "@/lib/desktop-bridge";
import {
  DESKTOP_EDIT_FILE_TYPE_DETAILS,
  type DesktopEditFileType,
} from "@/lib/desktop-edit-formats";
import { showDesktopEditOpenResultToast } from "@/lib/desktop-edit-status-toast";
import { isUnauthorizedError } from "@/lib/errors/auth";
import { notifyUserError } from "@/lib/errors/user-toast";

export type DesktopOpenTarget = {
  entityId: string;
  fileType: DesktopEditFileType;
  propertyId: string;
  workspaceId: string;
};

export const useDesktopFileOpen = (target: DesktopOpenTarget | null) => {
  const t = useTranslations();
  const [isOpening, setIsOpening] = useState(false);
  const application =
    target === null
      ? ""
      : DESKTOP_EDIT_FILE_TYPE_DETAILS[target.fileType].application;

  const open = async () => {
    if (isOpening || target === null) {
      return;
    }

    setIsOpening(true);
    try {
      const linkedAccount = await getFreshLinkedAccount();
      const openResult = await openFileInDesktop({
        apiBaseUrl: externalApiOrigin(),
        entityId: target.entityId,
        linkedAccount,
        propertyId: target.propertyId,
        workspaceId: target.workspaceId,
      });

      await showDesktopEditOpenResultToast({
        messages: {
          accountRequiredTitle: t(
            "workspaces.files.desktopEdit.accountRequiredTitle",
          ),
          notOpenedDescription: t.rich(
            "workspaces.files.desktopEdit.notOpenedDescription",
            {
              application,
              bdi: (chunks) => <bdi dir="ltr">{chunks}</bdi>,
            },
          ),
          openedDescription: t.rich(
            "workspaces.files.desktopEdit.openedDescription",
            {
              application,
              bdi: (chunks) => <bdi dir="ltr">{chunks}</bdi>,
            },
          ),
          openedTitle: t("workspaces.files.desktopEdit.openedTitle"),
          sentDescription: t.rich(
            "workspaces.files.desktopEdit.sentDescription",
            {
              application,
              bdi: (chunks) => <bdi dir="ltr">{chunks}</bdi>,
            },
          ),
          sentTitle: t("workspaces.files.desktopEdit.sentTitle"),
          unavailableTitle: t("workspaces.files.desktopEdit.unavailableTitle"),
          updateRequiredDescription: t(
            "workspaces.files.desktopEdit.updateRequiredDescription",
          ),
          updateRequiredTitle: t(
            "workspaces.files.desktopEdit.updateRequiredTitle",
          ),
        },
        result: openResult,
      });
    } catch (error) {
      setIsOpening(false);
      if (error instanceof Error && isUnauthorizedError(error)) {
        notifyUserError(
          error,
          t("workspaces.files.desktopEdit.authRequiredTitle"),
          {
            description: t(
              "workspaces.files.desktopEdit.authRequiredDescription",
            ),
          },
        );
        return;
      }

      if (error instanceof DesktopBridgeIncompatibleError) {
        notifyUserError(
          error,
          t("workspaces.files.desktopEdit.updateRequiredTitle"),
          {
            description: t(
              "workspaces.files.desktopEdit.updateRequiredDescription",
            ),
          },
        );
        return;
      }

      getAnalytics().captureError(error);
      notifyUserError(
        error,
        t("workspaces.files.desktopEdit.unavailableTitle"),
        {
          description: t("workspaces.files.desktopEdit.unavailableDescription"),
        },
      );
      return;
    }
    setIsOpening(false);
  };

  return { isOpening, open };
};
