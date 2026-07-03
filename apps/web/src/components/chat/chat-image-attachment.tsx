import { useState } from "react";

import { useTranslations } from "use-intl";

import {
  Dialog,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "@stll/ui/components/dialog";

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
      <button
        aria-label={t("common.preview")}
        className="focus-visible:ring-ring cursor-zoom-in rounded-md focus-visible:ring-2 focus-visible:outline-none"
        onClick={() => setOpen(true)}
        type="button"
      >
        <img
          alt={alt}
          className="max-h-32 rounded-md object-cover"
          height={128}
          src={thumbnailSrc}
          style={thumbnailStyle}
          width={128}
        />
      </button>
      <Dialog onOpenChange={setOpen} open={open}>
        <DialogPopup className="max-w-4xl">
          <DialogTitle className="sr-only">{alt}</DialogTitle>
          <DialogPanel className="flex justify-center p-2">
            <img
              alt={alt}
              className="max-h-[min(70vh,48rem)] w-full object-contain"
              src={fullSrc}
            />
          </DialogPanel>
        </DialogPopup>
      </Dialog>
    </>
  );
};
