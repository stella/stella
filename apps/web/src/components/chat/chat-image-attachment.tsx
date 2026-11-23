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
import { XIcon } from "@stll/ui/icons";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@stll/ui/tooltip";
import { cn } from "@stll/ui/utils";

import { DocumentIcon } from "@/components/document-icon";
import { useExternalSyncEffect } from "@/hooks/use-effect";

type ImagePreviewDialogProps = {
  alt: string;
  fullSrc: string;
  onOpenChange: (open: boolean) => void;
  open: boolean;
};

const ImagePreviewDialog = ({
  alt,
  fullSrc,
  onOpenChange,
  open,
}: ImagePreviewDialogProps) => (
  <Dialog onOpenChange={onOpenChange} open={open}>
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
);

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
        className="cursor-zoom-in overflow-hidden"
        onClick={() => setOpen(true)}
        variant="plain"
      >
        <img
          alt={alt}
          className="border-border/80 max-h-32 rounded-xl border object-cover"
          decoding="async"
          height={128}
          src={thumbnailSrc}
          style={thumbnailStyle}
          width={128}
        />
      </Button>
      <ImagePreviewDialog
        alt={alt}
        fullSrc={fullSrc}
        onOpenChange={setOpen}
        open={open}
      />
    </>
  );
};

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
  const t = useTranslations();
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

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
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              aria-label={`${t("common.preview")}: ${filename}`}
              className={cn(
                "block size-full overflow-hidden",
                dialogSrc !== undefined ? "cursor-zoom-in" : "cursor-default",
              )}
              onClick={() => {
                if (dialogSrc !== undefined) {
                  setOpen(true);
                }
              }}
              variant="plain"
            />
          }
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
              <DocumentIcon
                className="text-muted-foreground size-5"
                mimeType={mimeType}
              />
            </span>
          )}
        </TooltipTrigger>
        <TooltipPopup>
          <bdi>{filename}</bdi>
        </TooltipPopup>
      </Tooltip>
      {remove !== undefined && (
        <Button
          aria-label={remove.label}
          className="absolute end-1 top-1 inline-flex size-5 items-center justify-center opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 focus-visible:opacity-100 pointer-coarse:size-7 pointer-coarse:opacity-100"
          onClick={remove.onRemove}
          tooltip={remove.label}
          variant="plain"
        >
          <span className="bg-background/85 text-foreground hover:bg-background border-border/80 inline-flex size-full items-center justify-center rounded-full border shadow-xs backdrop-blur-xs">
            <XIcon aria-hidden="true" className="size-3" />
          </span>
        </Button>
      )}
      {dialogSrc !== undefined && (
        <ImagePreviewDialog
          alt={filename}
          fullSrc={dialogSrc}
          onOpenChange={setOpen}
          open={open}
        />
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

  const previewSrc =
    preview !== null && preview.file === file ? preview.src : undefined;

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
