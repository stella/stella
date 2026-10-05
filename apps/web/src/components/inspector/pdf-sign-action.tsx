import { useState } from "react";

import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { Dialog, DialogPopup } from "@stll/ui/dialog";
import { SignatureIcon } from "@stll/ui/icons";

import { PdfSignPlacement } from "@/components/inspector/pdf-sign-placement";
import type { PdfSignableFile } from "@/components/inspector/pdf-signing";
import { useDesktopPdfSign } from "@/components/inspector/use-desktop-pdf-sign";
import {
  DesktopRequiredDialog,
  useDesktopActionGate,
} from "@/features/desktop/desktop-action-gate";
import type { DesktopRequiredDialogProps } from "@/features/desktop/desktop-action-gate";
import { detached } from "@/lib/detached";

export type PdfSignTarget = PdfSignableFile & { fieldId: string };

type PdfSignFlow = {
  /** What the action does in the current desktop presence. */
  label: string;
  isConnecting: boolean;
  start: () => void;
  placementOpen: boolean;
  setPlacementOpen: (open: boolean) => void;
  requiredDialog: DesktopRequiredDialogProps;
};

/**
 * The sign action's state, kept by whoever outlives the trigger: a menu item
 * unmounts with its menu, so the row menu holds the flow beside the menu and
 * renders {@link PdfSignDialogs} there.
 */
export const usePdfSignFlow = (): PdfSignFlow => {
  const gate = useDesktopActionGate("sign-pdf");
  const [placementOpen, setPlacementOpen] = useState(false);
  return {
    label: gate.label,
    isConnecting: gate.isConnecting,
    start: () => {
      gate.run(() => setPlacementOpen(true));
    },
    placementOpen,
    setPlacementOpen,
    requiredDialog: gate.requiredDialog,
  };
};

type PdfSignDialogsProps = {
  flow: PdfSignFlow;
  target: PdfSignTarget;
};

/** Stamp placement, then the desktop hand-off; or what the desktop needs first. */
export const PdfSignDialogs = ({ flow, target }: PdfSignDialogsProps) => {
  const { sign } = useDesktopPdfSign(target);
  return (
    <>
      <Dialog onOpenChange={flow.setPlacementOpen} open={flow.placementOpen}>
        <DialogPopup className="sm:max-w-xl">
          <PdfSignPlacement
            fieldId={target.fieldId}
            onConfirm={(stamp) => {
              flow.setPlacementOpen(false);
              detached(sign(stamp), "pdf-sign-action.sign");
            }}
            workspaceId={target.workspaceId}
          />
        </DialogPopup>
      </Dialog>
      <DesktopRequiredDialog {...flow.requiredDialog} />
    </>
  );
};

type PdfSignButtonProps = {
  target: PdfSignTarget;
  /** `icon` for dense headers; `labelled` where people look for the action. */
  presentation: "icon" | "labelled";
};

export const PdfSignButton = ({ presentation, target }: PdfSignButtonProps) => {
  const t = useTranslations();
  const flow = usePdfSignFlow();
  return (
    <>
      {presentation === "icon" ? (
        <Button
          aria-label={flow.label}
          disabled={flow.isConnecting}
          onClick={flow.start}
          size="icon-xs"
          tooltip={flow.label}
          variant="ghost"
        >
          <SignatureIcon className="size-3.5" />
        </Button>
      ) : (
        <Button
          disabled={flow.isConnecting}
          onClick={flow.start}
          size="sm"
          tooltip={flow.label}
          variant="ghost"
        >
          <SignatureIcon />
          {t("workspaces.files.desktopGate.signShort")}
        </Button>
      )}
      <PdfSignDialogs flow={flow} target={target} />
    </>
  );
};
