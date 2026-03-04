import { forwardRef, useImperativeHandle, useState } from "react";
import type { SuggestionOptions, SuggestionProps } from "@tiptap/suggestion";
import { FileTextIcon, FolderIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stella/ui/components/button";
import { Popover, PopoverPopup } from "@stella/ui/components/popover";
import { cn } from "@stella/ui/lib/utils";

import type { ChatMentionOption } from "@/components/chat-mention-extension";
import { DocumentIcon } from "@/routes/_protected.workspaces/$workspaceId/-components/document-icon";

const MentionIcon = ({
  kind,
  mimeType,
}: {
  kind: string;
  mimeType: string | null;
}) => {
  if (kind === "folder") {
    return <FolderIcon className="size-3.5 shrink-0 text-muted-foreground" />;
  }

  if (mimeType) {
    return <DocumentIcon className="size-3.5 shrink-0" mimeType={mimeType} />;
  }

  return <FileTextIcon className="size-3.5 shrink-0 text-muted-foreground" />;
};

export const ChatMentionList = forwardRef<
  ReturnType<NonNullable<SuggestionOptions["render"]>>,
  SuggestionProps<ChatMentionOption>
>(({ items, command, decorationNode }, ref) => {
  const t = useTranslations();
  const [isOpen, setIsOpen] = useState(true);
  const [selectedIndex, setSelectedIndex] = useState(0);

  // Clamp index when the list shrinks below the current selection.
  const safeIndex = Math.min(selectedIndex, Math.max(0, items.length - 1));

  const selectItem = (index: number) => {
    const item = items.at(index);
    if (item) {
      command(item);
    }
  };

  useImperativeHandle(ref, () => ({
    onKeyDown: ({ event }) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        setIsOpen(false);
        return true;
      }

      if (event.key === "ArrowUp") {
        setSelectedIndex((safeIndex + items.length - 1) % items.length);
        return true;
      }

      if (event.key === "ArrowDown") {
        setSelectedIndex((safeIndex + 1) % items.length);
        return true;
      }

      if (event.key === "Enter") {
        selectItem(safeIndex);
        return true;
      }

      return false;
    },
  }));

  return (
    <Popover modal={true} onOpenChange={setIsOpen} open={isOpen}>
      <PopoverPopup
        align="start"
        anchor={decorationNode}
        className="*:data-[slot=popover-positioner]:transition-none! *:data-[slot=popover-viewport]:p-1!"
        initialFocus={false}
        side="top"
      >
        <div className="flex max-h-48 min-w-48 flex-col gap-0.5 overflow-y-auto">
          {items.length === 0 && (
            <div className="flex items-center justify-center p-2 text-center text-sm text-muted-foreground">
              {t("chat.mention.noResults")}
            </div>
          )}
          {items.map((item, index) => (
            <Button
              className={cn(
                "justify-start gap-2 font-normal",
                safeIndex === index && "bg-accent text-accent-foreground",
              )}
              key={item.id}
              onClick={() => selectItem(index)}
              size="sm"
              variant="ghost"
            >
              <MentionIcon kind={item.kind} mimeType={item.mimeType} />
              <span className="truncate">{item.label}</span>
            </Button>
          ))}
        </div>
      </PopoverPopup>
    </Popover>
  );
});

ChatMentionList.displayName = "ChatMentionList";
