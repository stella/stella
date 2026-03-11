/**
 * Attachment chips displayed above the chat input, showing
 * pending files with their upload status and remove buttons.
 */

import { Loader2Icon, XIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stella/ui/components/button";
import { cn } from "@stella/ui/lib/utils";

import { DocumentIcon } from "@/routes/_protected.workspaces/$workspaceId/-components/document-icon";

type PendingFile = {
  id: string;
  filename: string;
  mimeType: string;
  status: "uploading" | "ready" | "error";
  errorMessage?: string;
};

type AttachmentChipsProps = {
  files: PendingFile[];
  onRemove: (id: string) => void;
};

export const AttachmentChips = ({ files, onRemove }: AttachmentChipsProps) => {
  const t = useTranslations();

  if (files.length === 0) {
    return null;
  }

  return (
    <div className="flex gap-1.5 overflow-x-auto px-2 pt-2">
      {files.map((file) => (
        <div
          className={cn(
            "flex shrink-0 items-center gap-1.5",
            "bg-muted/50 rounded-md border px-2 py-1 text-xs",
            file.status === "error" &&
              "border-destructive/50 bg-destructive/10",
          )}
          key={file.id}
        >
          {file.status === "uploading" ? (
            <Loader2Icon className="text-muted-foreground size-3 animate-spin" />
          ) : (
            <DocumentIcon
              className="text-muted-foreground size-3"
              mimeType={file.mimeType}
            />
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
