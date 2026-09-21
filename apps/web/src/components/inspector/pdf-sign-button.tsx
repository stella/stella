import { SignatureIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { Loader } from "@stll/ui/loader";

import { useDesktopPdfSign } from "@/components/inspector/use-desktop-pdf-sign";
import { detached } from "@/lib/detached";
import type { PdfSigningTarget } from "@/lib/pdf-signing";

export const PdfSignButton = ({
  entityId,
  propertyId,
  workspaceId,
}: PdfSigningTarget) => {
  const t = useTranslations();
  const label = t("workspaces.files.pdfSigning.action");
  const { isSigning, sign } = useDesktopPdfSign({
    entityId,
    propertyId,
    workspaceId,
  });

  return (
    <Button
      aria-label={label}
      disabled={isSigning}
      onClick={() => {
        detached(sign(), "pdf-sign-button.sign");
      }}
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
  );
};
