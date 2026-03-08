/**
 * Attachment chips displayed above the chat input, showing
 * pending files with their upload status and remove buttons.
 */

import { FileTextIcon, ImageIcon, Loader2Icon, XIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stella/ui/components/button";
import { cn } from "@stella/ui/lib/utils";

type PendingFile = {
  id: string;
  filename: string;
  status: "uploading" | "ready" | "error";
  errorMessage?: string;
};

type AttachmentChipsProps = {
  files: PendingFile[];
  onRemove: (id: string) => void;
};

const isImageFile = (filename: string): boolean => {
  const ext = filename.split(".").pop()?.toLowerCase();
  return (
    ext === "png" ||
    ext === "jpg" ||
    ext === "jpeg" ||
    ext === "webp" ||
    ext === "gif"
  );
};

export const AttachmentChips = ({ files, onRemove }: AttachmentChipsProps) => {
  const t = useTranslations();

  if (files.length === 0) {
    return null;
  }

  return (
    <div className="flex flex-wrap gap-1.5 px-2 pt-2">
      {files.map((file) => (
        <div
          className={cn(
            "flex items-center gap-1.5 rounded-md",
            "border bg-muted/50 px-2 py-1 text-xs",
            file.status === "error" &&
              "border-destructive/50 bg-destructive/10",
          )}
          key={file.id}
        >
          {file.status === "uploading" ? (
            <Loader2Icon className="size-3 animate-spin text-muted-foreground" />
          ) : isImageFile(file.filename) ? (
            <ImageIcon className="size-3 text-muted-foreground" />
          ) : (
            <FileTextIcon className="size-3 text-muted-foreground" />
          )}
          <span className="max-w-[120px] truncate">
            {file.status === "uploading"
              ? t("chat.extractingContent")
              : file.filename}
          </span>
          <Button
            className="size-4 p-0"
            onClick={() => onRemove(file.id)}
            size="icon-xs"
            variant="ghost"
          >
            <XIcon className="size-2.5" />
          </Button>
        </div>
      ))}
    </div>
  );
};
