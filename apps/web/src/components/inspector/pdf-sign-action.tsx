import { lazy, Suspense, useState } from "react";

import { useTranslations } from "use-intl";

import { Dialog, DialogPopup } from "@stll/ui/dialog";
import { SignatureIcon } from "@stll/ui/icons";
import { Loader } from "@stll/ui/loader";
import { ToolbarIconAction } from "@stll/ui/toolbar-icon-action";

import type { PdfSignableFile } from "@/components/inspector/pdf-signing";
import {
  type PdfSignRequest,
  useDesktopPdfSign,
} from "@/components/inspector/use-desktop-pdf-sign";
import {
  DesktopRequiredDialog,
  useDesktopActionGate,
} from "@/features/desktop/desktop-action-gate";
import type { DesktopRequiredDialogProps } from "@/features/desktop/desktop-action-gate";
import { detachedUserAction } from "@/lib/errors/user-toast";
import { CapabilityAction } from "@/lib/organization/feature-access/capability-actions";

export type PdfSignTarget = PdfSignableFile & { fieldId: string };

// The placement preview renders the page with pdf.js; loading it only when the
// dialog opens keeps pdf.js out of every surface that merely offers signing
// (the row menu, the reader toolbar).
const LazyPdfSignPlacement = lazy(async () => {
  const module = await import("@/components/inspector/pdf-sign-placement");
  return { default: module.PdfSignPlacement };
});

type PdfSignFlow = {
  /** What the action does in the current desktop presence, or that it runs. */
  label: string;
  isConnecting: boolean;
  /** A signing exchange is open in stella desktop. */
  isSigning: boolean;
  start: () => void;
  sign: (request: PdfSignRequest) => Promise<void>;
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
  const t = useTranslations();
  const gate = useDesktopActionGate("sign-pdf");
  const signing = useDesktopPdfSign({ connectDesktop: gate.connect });
  const [placementOpen, setPlacementOpen] = useState(false);
  return {
    label: signing.isSigning
      ? t("workspaces.files.pdfSigning.signingLabel")
      : gate.label,
    isConnecting: gate.isConnecting,
    isSigning: signing.isSigning,
    start: () => {
      if (signing.isSigning) {
        signing.notifyAlreadySigning();
        return;
      }
      gate.run(() => setPlacementOpen(true));
    },
    sign: signing.sign,
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
                detachedUserAction(flow.sign({ stamp, target }), {
                  context: "pdf-sign-action.sign",
                  failureMessage: t(
                    "workspaces.files.pdfSigning.startFailedTitle",
                  ),
                });
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
      <CapabilityAction action={{ capability: "desktop" }} surface="control">
        {(capabilityProps) => (
          <ToolbarIconAction
            density="toolbar"
            disabled={flow.isConnecting}
            icon={<SignatureIcon className="size-3.5" />}
            label={flow.label}
            onClick={flow.start}
            {...capabilityProps}
          />
        )}
      </CapabilityAction>
      <PdfSignDialogs flow={flow} target={target} />
    </>
  );
};
