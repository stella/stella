import { useId, useState } from "react";

import { useTranslations } from "use-intl";

import { DirectionalIcon } from "@stll/ui/directional-icon";
import { ChevronRightIcon, TextIcon, XIcon } from "@stll/ui/icons";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@stll/ui/tooltip";
import { cn } from "@stll/ui/utils";

import type { ChatDraftAttachment } from "@/components/chat-editor-provider";
import { DocumentIcon } from "@/components/document-icon";

type ChatAttachmentChipItem =
  | Omit<Extract<ChatDraftAttachment, { type: "file" }>, "file">
  | Extract<ChatDraftAttachment, { type: "pasted_text" }>;

type ChatAttachmentChipProps = {
  item: ChatAttachmentChipItem;
  behavior:
    | {
        type: "draft";
        onRemove: (id: string) => void;
        onExpand: (id: string) => void;
      }
    | { type: "sent" };
};

export const ChatAttachmentChip = ({
  item,
  behavior,
}: ChatAttachmentChipProps) => {
  const t = useTranslations();
  const [disclosure, setDisclosure] = useState<"collapsed" | "expanded">(
    "collapsed",
  );
  const contentId = useId();
  const title =
    item.type === "file"
      ? item.filename
      : (item.text
          .split(/\r\n|\r|\n/u)
          .find((line) => line.trim().length > 0) ??
        t("chat.pastedText.title"));
  const expanded = disclosure === "expanded";
  let expandLabel = t("chat.pastedText.expand");
  if (behavior.type === "draft") {
    expandLabel = t("chat.pastedText.showInTextField");
  } else if (expanded) {
    expandLabel = t("common.showLess");
  }

  return (
    <div className="max-w-full min-w-0">
      <div className="bg-muted/50 flex w-fit max-w-full items-center gap-1.5 rounded-md border px-2 py-1 text-xs">
        {item.type === "file" ? (
          <DocumentIcon
            className="text-muted-foreground size-3 shrink-0"
            mimeType={item.mimeType}
          />
        ) : (
          <TextIcon
            aria-hidden="true"
            className="text-muted-foreground size-3 shrink-0"
          />
        )}
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                className="focus-visible:outline-ring max-w-40 min-w-0 cursor-default truncate rounded-sm text-start focus-visible:outline-2"
                dir="auto"
                type="button"
              />
            }
          >
            <bdi>{title}</bdi>
          </TooltipTrigger>
          <TooltipPopup>
            <bdi>{title}</bdi>
          </TooltipPopup>
        </Tooltip>
        {item.type === "pasted_text" && (
          <button
            aria-controls={behavior.type === "sent" ? contentId : undefined}
            aria-expanded={behavior.type === "sent" ? expanded : undefined}
            aria-label={expandLabel}
            onClick={() => {
              if (behavior.type === "draft") {
                behavior.onExpand(item.id);
                return;
              }
              setDisclosure(expanded ? "collapsed" : "expanded");
            }}
            className="hover:bg-accent focus-visible:outline-ring inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-md focus-visible:outline-2"
            title={expandLabel}
            type="button"
          >
            <DirectionalIcon
              className={cn("size-3", expanded && "rotate-90")}
              flip={!expanded}
              icon={ChevronRightIcon}
            />
          </button>
        )}
        {behavior.type === "draft" && (
          <button
            aria-label={t("common.remove")}
            onClick={() => behavior.onRemove(item.id)}
            className="hover:bg-accent focus-visible:outline-ring inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-md focus-visible:outline-2"
            title={t("common.remove")}
            type="button"
          >
            <XIcon aria-hidden="true" className="size-3" />
          </button>
        )}
      </div>
      {item.type === "pasted_text" && behavior.type === "sent" && (
        <pre
          className="bg-muted/50 mt-1 max-h-80 overflow-auto rounded-md border p-3 text-sm wrap-break-word whitespace-pre-wrap"
          dir="auto"
          hidden={!expanded}
          id={contentId}
        >
          {item.text}
        </pre>
      )}
    </div>
  );
};

type ChatDraftAttachmentChipsProps = {
  files: ChatDraftAttachment[];
  onRemove: (id: string) => void;
  onExpand: (id: string) => void;
};

export const ChatDraftAttachmentChips = ({
  files,
  onRemove,
  onExpand,
}: ChatDraftAttachmentChipsProps) => {
  if (files.length === 0) {
    return null;
  }

  return (
    <div className="flex flex-wrap gap-1.5 px-2 pt-2">
      {files.map((item) => (
        <ChatAttachmentChip
          behavior={{ type: "draft", onRemove, onExpand }}
          item={item}
          key={item.id}
        />
      ))}
    </div>
  );
};
