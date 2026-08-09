import { useState } from "react";

import { LaptopIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/components/button";
import { stellaToast } from "@stll/ui/components/toast";
import { cn } from "@stll/ui/lib/utils";

import Tooltip from "@/components/tooltip";
import { env } from "@/env";
import { getAnalytics } from "@/lib/analytics/provider";
import { getFreshLinkedAccount } from "@/lib/auth-session";
import {
  DesktopBridgeIncompatibleError,
  openFileInDesktop,
} from "@/lib/desktop-bridge";
import {
  DESKTOP_EDIT_FILE_TYPES,
  type DesktopEditFileType,
} from "@/lib/desktop-edit-formats";
import { showDesktopEditOpenResultToast } from "@/lib/desktop-edit-status-toast";
import { detached } from "@/lib/detached";
import { isUnauthorizedError } from "@/lib/errors/auth";

export const DesktopOpenButton = ({
  entityId,
  fileType,
  propertyId,
  workspaceId,
}: {
  entityId: string;
  fileType: DesktopEditFileType;
  propertyId: string;
  workspaceId: string;
}) => {
  const t = useTranslations();
  const [isOpening, setIsOpening] = useState(false);
  const application = DESKTOP_EDIT_FILE_TYPES[fileType].application;
  const label = t("workspaces.files.desktopEdit.openAction");

  const handleOpen = async () => {
    if (isOpening) {
      return;
    }

    setIsOpening(true);
    try {
      const linkedAccount = await getFreshLinkedAccount();
      const openResult = await openFileInDesktop({
        apiBaseUrl: env.VITE_API_URL,
        entityId,
        linkedAccount,
        propertyId,
        workspaceId,
      });

      await showDesktopEditOpenResultToast({
        messages: {
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
      if (error instanceof Error && isUnauthorizedError(error)) {
        stellaToast.add({
          description: t(
            "workspaces.files.desktopEdit.authRequiredDescription",
          ),
          title: t("workspaces.files.desktopEdit.authRequiredTitle"),
          type: "error",
        });
        return;
      }

      if (error instanceof DesktopBridgeIncompatibleError) {
        stellaToast.add({
          description: t(
            "workspaces.files.desktopEdit.updateRequiredDescription",
          ),
          title: t("workspaces.files.desktopEdit.updateRequiredTitle"),
          type: "error",
        });
        return;
      }

      getAnalytics().captureError(error);
      stellaToast.add({
        description: t("workspaces.files.desktopEdit.unavailableDescription"),
        title: t("workspaces.files.desktopEdit.unavailableTitle"),
        type: "error",
      });
    } finally {
      setIsOpening(false);
    }
  };

  return (
    <Tooltip
      content={label}
      render={
        <Button
          aria-label={label}
          disabled={isOpening}
          onClick={() => {
            detached(handleOpen(), "DesktopOpenButton");
          }}
          size="icon-xs"
          variant="ghost"
        >
          <LaptopIcon
            className={cn("size-3.5", isOpening && "animate-pulse")}
          />
        </Button>
      }
    />
  );
};
