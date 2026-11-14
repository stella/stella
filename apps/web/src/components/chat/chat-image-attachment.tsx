import { useState } from "react";

import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import {
  Dialog,
  DIALOG_MOBILE_LAYOUT,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "@stll/ui/dialog";

type ChatImageAttachmentProps = {
  alt: string;
  fullSrc: string;
  thumbnailSrc: string;
  thumbnailStyle?: React.CSSProperties | undefined;
};

export const ChatImageAttachment = ({
  alt,
  fullSrc,
  thumbnailSrc,
  thumbnailStyle,
}: ChatImageAttachmentProps) => {
  const t = useTranslations();
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button
        aria-label={`${t("common.preview")}: ${alt}`}
        className="cursor-zoom-in"
        onClick={() => setOpen(true)}
        variant="plain"
      >
        <img
          alt={alt}
          className="max-h-32 rounded-md object-cover"
          height={128}
          src={thumbnailSrc}
          style={thumbnailStyle}
          width={128}
        />
      </Button>
      <Dialog onOpenChange={setOpen} open={open}>
        <DialogPopup
          mobileLayout={DIALOG_MOBILE_LAYOUT.centered}
          className="max-w-4xl"
        >
          <DialogTitle className="sr-only">{alt}</DialogTitle>
          <DialogPanel className="flex justify-center p-2">
            <img
              alt={alt}
              className="max-h-[min(70dvh,48rem)] w-full object-contain"
              src={fullSrc}
            />
          </DialogPanel>
        </DialogPopup>
      </Dialog>
    </>
  );
};
