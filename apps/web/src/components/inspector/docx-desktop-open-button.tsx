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
  openDocxInDesktop,
} from "@/lib/desktop-bridge";
import { showDesktopEditOpenResultToast } from "@/lib/desktop-edit-status-toast";
import { isUnauthorizedError } from "@/lib/errors";

export const DocxDesktopOpenButton = ({
  entityId,
  propertyId,
  workspaceId,
}: {
  entityId: string;
  propertyId: string;
  workspaceId: string;
}) => {
  const t = useTranslations();
  const [isOpening, setIsOpening] = useState(false);
  const label = t("workspaces.files.desktopEdit.openAction");

  const handleOpen = async () => {
    if (isOpening) {
      return;
    }

    setIsOpening(true);
    try {
      const linkedAccount = await getFreshLinkedAccount();
      const openResult = await openDocxInDesktop({
        apiBaseUrl: env.VITE_API_URL,
        entityId,
        linkedAccount,
        propertyId,
        workspaceId,
      });

      await showDesktopEditOpenResultToast({
        result: openResult,
        t,
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
            void handleOpen();
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
