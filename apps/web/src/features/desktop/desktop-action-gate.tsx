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
import { DownloadIcon, PlugIcon, RefreshCwIcon } from "@stll/ui/icons";
import type { LucideIcon } from "@stll/ui/icons";
import { MenuItem } from "@stll/ui/menu";
import { stellaToast } from "@stll/ui/toast";

import { DesktopDownloadButtons } from "@/components/desktop-download-buttons";
import {
  DESKTOP_ACTION_LABELS,
  DESKTOP_ACTION_REASONS,
  DESKTOP_SETUP_LABELS,
  getDesktopActionStatus,
} from "@/features/desktop/desktop-action-gate.logic";
import type {
  DesktopAction,
  DesktopActionStatus,
  DesktopSetupStep,
} from "@/features/desktop/desktop-action-gate.logic";
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
  status: DesktopActionStatus;
  isConnecting: boolean;
  /** Links the running app to this account, or offers the install. */
  connect: () => void;
  /** Starts the step the status names: connect, install or update. */
  setUp: (step: DesktopSetupStep) => void;
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
          // The app must update before it can link this account.
          case "update-required": {
            setRequired("outdated");
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

  const setUp = (step: DesktopSetupStep) => {
    switch (step) {
      case "connect": {
        connectApp();
        return;
      }
      case "install": {
        setRequired("none");
        return;
      }
      case "update": {
        setRequired("outdated");
        return;
      }
      default: {
        step satisfies never;
        panic(`Unhandled desktop setup step: ${String(step)}`);
      }
    }
  };

  const status = getDesktopActionStatus(presence.type);

  // Toasts retain this callback while presence continues to refresh.
  const run = useLatestCallback((perform: () => void) => {
    switch (status.type) {
      case "ready": {
        perform();
        return;
      }
      case "setup": {
        setUp(status.step);
        return;
      }
      default: {
        status satisfies never;
        panic("Unhandled desktop action status");
      }
    }
  });

  return {
    label: t(DESKTOP_ACTION_LABELS[action][presence.type]),
    status,
    isConnecting: state.status === "connecting",
    connect: connectApp,
    setUp,
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

const DESKTOP_SETUP_ICONS = {
  connect: PlugIcon,
  install: DownloadIcon,
  update: RefreshCwIcon,
} as const satisfies Record<DesktopSetupStep, LucideIcon>;

type DesktopSetupMenuItemProps = {
  status: DesktopActionStatus;
  onSetUp: (step: DesktopSetupStep) => void;
};

/**
 * The desktop status line at the top of a menu's desktop actions. The actions
 * keep naming what they do; this row says what stella desktop needs first and
 * starts that step.
 */
export const DesktopSetupMenuItem = ({
  onSetUp,
  status,
}: DesktopSetupMenuItemProps) => {
  const t = useTranslations();
  switch (status.type) {
    case "ready": {
      return null;
    }
    case "setup": {
      const Icon = DESKTOP_SETUP_ICONS[status.step];
      return (
        <MenuItem onClick={() => onSetUp(status.step)}>
          <Icon />
          {t(DESKTOP_SETUP_LABELS[status.step])}
        </MenuItem>
      );
    }
    default: {
      status satisfies never;
      return panic("Unhandled desktop action status");
    }
  }
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
