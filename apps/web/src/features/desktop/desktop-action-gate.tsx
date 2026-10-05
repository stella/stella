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

import { DesktopDownloadButtons } from "@/components/desktop-download-buttons";
import type { DesktopPresenceType } from "@/features/desktop/desktop-presence";
import { useDesktopPresence } from "@/features/desktop/desktop-presence";
import { useDesktopAccountConnection } from "@/features/desktop/use-desktop-account-connection";
import type { TranslationKey } from "@/i18n/types";
import { detectDesktopPlatform } from "@/lib/desktop-downloads";
import { detached } from "@/lib/detached";

/** Work that only stella desktop can do for a file. */
export type DesktopAction = "edit-file" | "sign-pdf";

/**
 * Each action stays visible in every presence and names what it will do:
 * run, update the app, connect it, or install it.
 */
const DESKTOP_ACTION_LABELS = {
  "edit-file": {
    current: "workspaces.files.desktopEdit.openAction",
    none: "workspaces.files.desktopGate.editNone",
    not_connected: "workspaces.files.desktopGate.connect",
    outdated: "workspaces.files.desktopGate.editOutdated",
  },
  "sign-pdf": {
    current: "workspaces.files.desktopGate.signCurrent",
    none: "workspaces.files.desktopGate.signNone",
    not_connected: "workspaces.files.desktopGate.connect",
    outdated: "workspaces.files.desktopGate.signOutdated",
  },
} as const satisfies Record<
  DesktopAction,
  Record<DesktopPresenceType, TranslationKey>
>;

/** Why the action needs the desktop app, shown before installing it. */
const DESKTOP_ACTION_REASONS = {
  "edit-file": "workspaces.files.desktopGate.editReason",
  "sign-pdf": "workspaces.files.desktopGate.signReason",
} as const satisfies Record<DesktopAction, TranslationKey>;

/** Presences that need the app installed or updated before the action. */
type DesktopRequiredPresence = Extract<
  DesktopPresenceType,
  "none" | "outdated"
>;

type DesktopActionGateResult = {
  label: string;
  isConnecting: boolean;
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
        // Nothing answered on this computer: offer the install instead.
        if (outcome.status === "error") {
          setRequired("none");
        }
      })(),
      "desktop-action-gate.connect",
    );
  };

  const run = (perform: () => void) => {
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
        presence satisfies never;
        panic(`Unhandled desktop presence: ${String(presence)}`);
      }
    }
  };

  return {
    label: t(DESKTOP_ACTION_LABELS[action][presence.type]),
    isConnecting: state.status === "connecting",
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
          <DialogTitle>
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
