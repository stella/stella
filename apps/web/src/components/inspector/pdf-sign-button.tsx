import { useState } from "react";

import { SignatureIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { Dialog, DialogPopup, DialogTrigger } from "@stll/ui/dialog";
import { Loader } from "@stll/ui/loader";

import { PdfSignPlacement } from "@/components/inspector/pdf-sign-placement";
import type { PdfSignableFile } from "@/components/inspector/pdf-signing";
import { useDesktopPdfSign } from "@/components/inspector/use-desktop-pdf-sign";
import { detached } from "@/lib/detached";

export const PdfSignButton = ({
  entityId,
  fieldId,
  propertyId,
  workspaceId,
}: PdfSignableFile & { fieldId: string }) => {
  const t = useTranslations();
  const label = t("workspaces.files.pdfSigning.action");
  const [open, setOpen] = useState(false);
  const { isSigning, sign } = useDesktopPdfSign({
    entityId,
    propertyId,
    workspaceId,
  });

  return (
    <Dialog onOpenChange={setOpen} open={open}>
      <DialogTrigger
        disabled={isSigning}
        render={
          <Button
            aria-label={label}
            disabled={isSigning}
            size="icon-xs"
            tooltip={label}
            variant="ghost"
          >
            {isSigning ? (
              <Loader
                label={t("workspaces.files.pdfSigning.waitingTitle")}
                size="sm"
              />
            ) : (
              <SignatureIcon className="size-3.5" />
            )}
          </Button>
        }
      />
      <DialogPopup className="sm:max-w-xl">
        <PdfSignPlacement
          fieldId={fieldId}
          onConfirm={(stamp) => {
            setOpen(false);
            detached(sign(stamp), "pdf-sign-button.sign");
          }}
          workspaceId={workspaceId}
        />
      </DialogPopup>
    </Dialog>
  );
};
