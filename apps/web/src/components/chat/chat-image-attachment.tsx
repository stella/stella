import { useState } from "react";
import type { ReactNode } from "react";

import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import {
  Dialog,
  DIALOG_MOBILE_LAYOUT,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "@stll/ui/dialog";
import { useExternalSyncEffect } from "@stll/ui/effects";
import { XIcon } from "@stll/ui/icons";
import { cn } from "@stll/ui/utils";

import { DocumentIcon } from "@/components/document-icon";

type ImagePreviewTriggerProps = {
  alt: string;
  children: ReactNode;
  className: string;
  fullSrc: string | undefined;
  tooltip?: ReactNode | undefined;
};

const ImagePreviewTrigger = ({
  alt,
  children,
  className,
  fullSrc,
  tooltip,
}: ImagePreviewTriggerProps) => {
  const t = useTranslations();
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button
        aria-label={`${t("common.preview")}: ${alt}`}
        className={cn(
          className,
          fullSrc !== undefined ? "cursor-zoom-in" : "cursor-default",
        )}
        onClick={() => {
          if (fullSrc !== undefined) {
            setOpen(true);
          }
        }}
        tooltip={tooltip}
        variant="plain"
      >
        {children}
      </Button>
      {fullSrc !== undefined && (
        <Dialog onOpenChange={setOpen} open={open}>
          <DialogPopup
            className="max-w-4xl"
            mobileLayout={DIALOG_MOBILE_LAYOUT.centered}
          >
            <DialogTitle className="sr-only">{alt}</DialogTitle>
            <DialogPanel className="flex justify-center p-2">
              <img
                alt={alt}
                className="max-h-[min(70dvh,48rem)] w-full object-contain"
                decoding="async"
                src={fullSrc}
              />
            </DialogPanel>
          </DialogPopup>
        </Dialog>
      )}
    </>
  );
};

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
}: ChatImageAttachmentProps) => (
  <ImagePreviewTrigger alt={alt} className="overflow-hidden" fullSrc={fullSrc}>
    <img
      alt={alt}
      className="border-border/80 max-h-32 rounded-xl border object-cover"
      decoding="async"
      height={128}
      src={thumbnailSrc}
      style={thumbnailStyle}
      width={128}
    />
  </ImagePreviewTrigger>
);

type ChatImageThumbnailCardProps = {
  filename: string;
  fullSrc: string | undefined;
  mimeType: string;
  remove?:
    | {
        label: string;
        onRemove: () => void;
      }
    | undefined;
  thumbnailSrc: string | undefined;
};

export const ChatImageThumbnailCard = ({
  filename,
  fullSrc,
  mimeType,
  remove,
  thumbnailSrc,
}: ChatImageThumbnailCardProps) => {
  const [failedSrc, setFailedSrc] = useState<string | null>(null);

  const visibleThumbnailSrc =
    thumbnailSrc !== undefined && failedSrc !== thumbnailSrc
      ? thumbnailSrc
      : undefined;
  const dialogSrc = visibleThumbnailSrc !== undefined ? fullSrc : undefined;

  return (
    <div
      className="bg-muted/50 border-border/80 group relative size-20 shrink-0 overflow-hidden rounded-xl border"
      data-draft-image-attachment=""
    >
      <ImagePreviewTrigger
        alt={filename}
        className="block size-full overflow-hidden"
        fullSrc={dialogSrc}
        tooltip={<bdi>{filename}</bdi>}
      >
        {visibleThumbnailSrc !== undefined ? (
          <img
            alt={filename}
            className="size-full object-cover"
            decoding="async"
            height={80}
            onError={() => setFailedSrc(visibleThumbnailSrc)}
            src={visibleThumbnailSrc}
            width={80}
          />
        ) : (
          <span className="flex size-full items-center justify-center">
            <DocumentIcon className="size-5" mimeType={mimeType} />
          </span>
        )}
      </ImagePreviewTrigger>
      {remove !== undefined && (
        <Button
          aria-label={remove.label}
          className="absolute end-1 top-1 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100"
          onClick={remove.onRemove}
          size="icon-2xs"
          tooltip={remove.label}
          variant="secondary"
        >
          <XIcon aria-hidden="true" className="size-3" />
        </Button>
      )}
    </div>
  );
};

type ChatDraftImageAttachmentProps = {
  file: File;
  filename: string;
  mimeType: string;
  onRemove: () => void;
};

export const ChatDraftImageAttachment = ({
  file,
  filename,
  mimeType,
  onRemove,
}: ChatDraftImageAttachmentProps) => {
  const t = useTranslations();
  const [preview, setPreview] = useState<{
    file: File;
    src: string;
  } | null>(null);

  useExternalSyncEffect(() => {
    const src = URL.createObjectURL(file);
    setPreview({ file, src });
    return () => URL.revokeObjectURL(src);
  }, [file]);

  const previewSrc = preview?.file === file ? preview.src : undefined;

  return (
    <ChatImageThumbnailCard
      filename={filename}
      fullSrc={previewSrc}
      mimeType={mimeType}
      remove={{ label: t("common.remove"), onRemove }}
      thumbnailSrc={previewSrc}
    />
  );
};
