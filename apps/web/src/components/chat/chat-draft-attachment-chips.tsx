import { Button } from "@stll/ui/components/button";
import { cn } from "@stll/ui/lib/utils";
import { XIcon } from "lucide-react";

import type { ChatDraftAttachment } from "@/components/chat-editor-provider";
import { DocumentIcon } from "@/routes/_protected.workspaces/$workspaceId/-components/document-icon";

type ChatDraftAttachmentChipsProps = {
  files: ChatDraftAttachment[];
  onRemove: (id: string) => void;
};

export const ChatDraftAttachmentChips = ({
  files,
  onRemove,
}: ChatDraftAttachmentChipsProps) => {
  if (files.length === 0) {
    return null;
  }

  return (
    <div className="flex gap-1.5 overflow-x-auto px-2 pt-2">
      {files.map((file) => (
        <div
          className={cn(
            "bg-muted/50 flex shrink-0 items-center gap-1.5 rounded-md border px-2 py-1 text-xs",
          )}
          key={file.id}
        >
          <DocumentIcon
            className="text-muted-foreground size-3"
            mimeType={file.mimeType}
          />
          <span className="max-w-[120px] truncate">{file.filename}</span>
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
