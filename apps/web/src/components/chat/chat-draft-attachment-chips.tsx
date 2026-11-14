import { useId, useState } from "react";

import { useTranslations } from "use-intl";

import { DirectionalIcon } from "@stll/ui/directional-icon";
import { ChevronRightIcon, CommandIcon, TextIcon, XIcon } from "@stll/ui/icons";
import { cn } from "@stll/ui/utils";

import type { ChatDraftAttachment } from "@/components/chat-editor-provider";
import { AttachmentChip } from "@/components/chat/attachment-chip";
import type {
  AttachmentChipAction,
  AttachmentChipKind,
} from "@/components/chat/attachment-chip";
import { DocumentIcon } from "@/components/document-icon";

type ChatAttachmentChipItem =
  | Omit<Extract<ChatDraftAttachment, { type: "file" }>, "file">
  | Extract<ChatDraftAttachment, { type: "pasted_text" }>;

const chipKind = (item: ChatAttachmentChipItem): AttachmentChipKind => {
  if (item.type === "pasted_text") {
    return "pasted_text";
  }
  return item.mimeType.startsWith("image/") ? "image" : "file";
};

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

  const actions: AttachmentChipAction[] = [];
  if (item.type === "pasted_text") {
    actions.push({
      type: "expand",
      label: expandLabel,
      icon: ({ className }) => (
        <DirectionalIcon
          className={cn(className, expanded && "rotate-90")}
          flip={!expanded}
          icon={ChevronRightIcon}
        />
      ),
      onClick: () => {
        if (behavior.type === "draft") {
          behavior.onExpand(item.id);
          return;
        }
        setDisclosure(expanded ? "collapsed" : "expanded");
      },
      disclosure:
        behavior.type === "sent"
          ? { controls: contentId, expanded }
          : undefined,
    });
  }
  if (behavior.type === "draft") {
    actions.push({
      type: "remove",
      label: t("common.remove"),
      icon: ({ className }) => (
        <XIcon aria-hidden="true" className={className} />
      ),
      onClick: () => behavior.onRemove(item.id),
    });
  }

  return (
    <div className="max-w-full min-w-0">
      <AttachmentChip
        actions={actions}
        icon={({ className }) =>
          item.type === "file" ? (
            <DocumentIcon className={className} mimeType={item.mimeType} />
          ) : (
            <TextIcon aria-hidden="true" className={className} />
          )
        }
        kind={chipKind(item)}
        title={title}
      />
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

/**
 * A reserved slash command such as `/new` in the composer: an action trigger,
 * not editable content, so it has no expand or remove action of its own.
 */
export const ChatCommandChip = ({ label }: { label: string }) => (
  <AttachmentChip
    icon={({ className }) => <CommandIcon className={className} />}
    kind="command"
    title={label}
  />
);

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
