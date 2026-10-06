import { lazy, Suspense, useState } from "react";

import { useTranslations } from "use-intl";

import { Dialog, DialogPopup } from "@stll/ui/dialog";
import { SignatureIcon } from "@stll/ui/icons";
import { Loader } from "@stll/ui/loader";
import { ToolbarIconAction } from "@stll/ui/toolbar-icon-action";

import type { PdfSignableFile } from "@/components/inspector/pdf-signing";
import { useDesktopPdfSign } from "@/components/inspector/use-desktop-pdf-sign";
import {
  DesktopRequiredDialog,
  useDesktopActionGate,
} from "@/features/desktop/desktop-action-gate";
import type { DesktopRequiredDialogProps } from "@/features/desktop/desktop-action-gate";
import { detached } from "@/lib/detached";

export type PdfSignTarget = PdfSignableFile & { fieldId: string };

// The placement preview renders the page with pdf.js; loading it only when the
// dialog opens keeps pdf.js out of every surface that merely offers signing
// (the row menu, the reader toolbar).
const LazyPdfSignPlacement = lazy(async () => {
  const module = await import("@/components/inspector/pdf-sign-placement");
  return { default: module.PdfSignPlacement };
});

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
  const t = useTranslations();
  const { sign } = useDesktopPdfSign(target);
  return (
    <>
      <Dialog onOpenChange={flow.setPlacementOpen} open={flow.placementOpen}>
        <DialogPopup className="sm:max-w-xl">
          <Suspense
            fallback={
              <div className="flex min-h-48 items-center justify-center">
                <Loader label={t("common.loading")} size="sm" />
              </div>
            }
          >
            <LazyPdfSignPlacement
              fieldId={target.fieldId}
              onConfirm={(stamp) => {
                flow.setPlacementOpen(false);
                detached(sign(stamp), "pdf-sign-action.sign");
              }}
              workspaceId={target.workspaceId}
            />
          </Suspense>
        </DialogPopup>
      </Dialog>
      <DesktopRequiredDialog {...flow.requiredDialog} />
    </>
  );
};

type PdfSignButtonProps = {
  target: PdfSignTarget;
};

export const PdfSignButton = ({ target }: PdfSignButtonProps) => {
  const flow = usePdfSignFlow();
  return (
    <>
      <ToolbarIconAction
        density="toolbar"
        disabled={flow.isConnecting}
        icon={<SignatureIcon className="size-3.5" />}
        label={flow.label}
        onClick={flow.start}
      />
      <PdfSignDialogs flow={flow} target={target} />
    </>
  );
};
