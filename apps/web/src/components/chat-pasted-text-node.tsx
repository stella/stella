import { NodeViewWrapper } from "@tiptap/react";
import type { NodeViewProps } from "@tiptap/react";
import { ClipboardPasteIcon, SparklesIcon, XIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/components/button";
import {
  Popover,
  PopoverPopup,
  PopoverTrigger,
} from "@stll/ui/components/popover";
import { cn } from "@stll/ui/lib/utils";

import type { PastedTextSource } from "@/components/chat-pasted-text-extension";

const CHIP_MAX_LABEL_WIDTH_CLASS = "max-w-48";

export const ChatPastedTextNode = (props: NodeViewProps) => {
  const t = useTranslations();
  // SAFETY: attrs from our own pastedText node schema
  // eslint-disable-next-line typescript/no-unsafe-type-assertion
  const attrs = props.node.attrs as {
    text: string;
    label: string;
    source: PastedTextSource;
  };

  const fallbackLabel =
    attrs.source === "prompt"
      ? t("chat.pastedText.fromPromptFallback")
      : t("chat.pastedText.fromClipboard", {
          count: attrs.text.length,
        });
  const chipLabel = attrs.label.length > 0 ? attrs.label : fallbackLabel;

  const Icon = attrs.source === "prompt" ? SparklesIcon : ClipboardPasteIcon;

  return (
    <NodeViewWrapper className="inline" data-source={attrs.source}>
      <Popover>
        <PopoverTrigger
          aria-label={t("chat.pastedText.expand")}
          className={cn(
            "inline-flex max-w-full items-center gap-1 align-middle",
            "bg-muted/60 hover:bg-muted rounded-md border px-1.5 py-0.5",
            "text-foreground text-xs font-medium",
            "focus-visible:ring-ring transition-colors focus-visible:ring-2 focus-visible:outline-none",
            "cursor-pointer select-none",
          )}
          contentEditable={false}
          type="button"
        >
          <Icon className="text-muted-foreground size-3 shrink-0" />
          <span className={cn("truncate", CHIP_MAX_LABEL_WIDTH_CLASS)}>
            {chipLabel}
          </span>
        </PopoverTrigger>
        <PopoverPopup className="w-(--available-width) max-w-md" side="top">
          <div className="flex max-h-72 flex-col gap-2 text-xs">
            <div className="flex items-center justify-between gap-2">
              <span className="text-muted-foreground truncate">
                {chipLabel}
              </span>
              <Button
                aria-label={t("chat.pastedText.remove")}
                className="size-5 p-0"
                onClick={() => props.deleteNode()}
                size="icon-xs"
                variant="ghost"
              >
                <XIcon className="size-3" />
              </Button>
            </div>
            <textarea
              aria-label={t("common.edit")}
              className="bg-muted/40 focus-visible:ring-ring max-h-60 min-h-32 resize-none overflow-auto rounded-md border p-2 font-mono text-[11px] whitespace-pre-wrap focus-visible:ring-2 focus-visible:outline-none"
              onChange={(event) => {
                props.updateAttributes({ text: event.target.value });
              }}
              spellCheck={false}
              value={attrs.text}
            />
          </div>
        </PopoverPopup>
      </Popover>
    </NodeViewWrapper>
  );
};
