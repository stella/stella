import { useState } from "react";

import { panic } from "better-result";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "@stll/ui/dialog";
import { stellaToast } from "@stll/ui/toast";

import { DesktopDownloadButtons } from "@/components/desktop-download-buttons";
import {
  DESKTOP_ACTION_LABELS,
  DESKTOP_ACTION_REASONS,
} from "@/features/desktop/desktop-action-gate.logic";
import type { DesktopAction } from "@/features/desktop/desktop-action-gate.logic";
import type { DesktopPresenceType } from "@/features/desktop/desktop-presence";
import { useDesktopPresence } from "@/features/desktop/desktop-presence";
import { useDesktopAccountConnection } from "@/features/desktop/use-desktop-account-connection";
import { useLatestCallback } from "@/hooks/use-latest-callback";
import { detectDesktopPlatform } from "@/lib/desktop-downloads";
import { detached } from "@/lib/detached";

/** Presences that need the app installed or updated before the action. */
type DesktopRequiredPresence = Extract<
  DesktopPresenceType,
  "none" | "outdated"
>;

type DesktopActionGateResult = {
  label: string;
  isConnecting: boolean;
  /** Links the running app to this account, or offers the install. */
  connect: () => void;
  /** Runs `perform` when the app can do it; otherwise connects or installs it. */
  run: (perform: () => void) => void;
  requiredDialog: DesktopRequiredDialogProps;
};

export const useDesktopActionGate = (
  action: DesktopAction,
): DesktopActionGateResult => {
  const t = useTranslations();
  const presence = useDesktopPresence();
  const { connect, state } = useDesktopAccountConnection();
  const [required, setRequired] = useState<DesktopRequiredPresence | null>(
    null,
  );

  const connectApp = () => {
    detached(
      (async () => {
        const outcome = await connect();
        switch (outcome.status) {
          case "connected": {
            stellaToast.add({
              title: t("workspaces.files.desktopGate.connected"),
              type: "success",
            });
            return;
          }
          // The app takes over in its own window and returns here.
          case "started": {
            return;
          }
          // Nothing answered on this computer: offer the install instead.
          case "error": {
            setRequired("none");
            return;
          }
          default: {
            outcome satisfies never;
            panic("Unhandled desktop connection outcome");
          }
        }
      })(),
      "desktop-action-gate.connect",
    );
  };

  // Toasts retain this callback while presence continues to refresh.
  const run = useLatestCallback((perform: () => void) => {
    switch (presence.type) {
      case "current": {
        perform();
        return;
      }
      case "not_connected": {
        connectApp();
        return;
      }
      case "none":
      case "outdated": {
        setRequired(presence.type);
        return;
      }
      default: {
        presence.type satisfies never;
        panic(`Unhandled desktop presence: ${String(presence.type)}`);
      }
    }
  });

  return {
    label: t(DESKTOP_ACTION_LABELS[action][presence.type]),
    isConnecting: state.status === "connecting",
    connect: connectApp,
    run,
    requiredDialog: {
      action,
      onClose: () => setRequired(null),
      onConnect: () => {
        setRequired(null);
        connectApp();
      },
      required,
    },
  };
};

export type DesktopRequiredDialogProps = {
  action: DesktopAction;
  onClose: () => void;
  onConnect: () => void;
  required: DesktopRequiredPresence | null;
};

/**
 * Install or update stella desktop, with the one reason the action needs it.
 * An app that is installed but not linked to this account looks the same as
 * no app, so the dialog also offers to connect one.
 */
export const DesktopRequiredDialog = ({
  action,
  onClose,
  onConnect,
  required,
}: DesktopRequiredDialogProps) => {
  const t = useTranslations();
  return (
    <Dialog
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
      open={required !== null}
    >
      <DialogPopup className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="me-6">
            {t(DESKTOP_ACTION_LABELS[action][required ?? "none"])}
          </DialogTitle>
          <DialogDescription>
            {t(DESKTOP_ACTION_REASONS[action])}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <DesktopDownloadButtons platform={detectDesktopPlatform()} />
        </DialogPanel>
        {required === "none" && (
          <DialogFooter>
            <Button onClick={onConnect} size="sm" variant="ghost">
              {t("workspaces.files.desktopGate.alreadyInstalled")}
            </Button>
          </DialogFooter>
        )}
      </DialogPopup>
    </Dialog>
  );
};
