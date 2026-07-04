import { useState } from "react";

import { NodeViewWrapper } from "@tiptap/react";
import type { NodeViewProps } from "@tiptap/react";
import {
  ClipboardPasteIcon,
  CommandIcon,
  SparklesIcon,
  WandSparklesIcon,
  XIcon,
} from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/components/button";
import {
  Popover,
  PopoverPopup,
  PopoverTrigger,
} from "@stll/ui/components/popover";
import { contentDir } from "@stll/ui/hooks/use-content-dir";
import { cn } from "@stll/ui/lib/utils";

import type {
  PastedTextAttrs,
  PastedTextSource,
} from "@/components/chat-pasted-text-extension";

const CHIP_MAX_LABEL_WIDTH_CLASS = "max-w-48";

// Shared chip shell so the interactive paste/prompt/skill trigger and the
// static command chip stay visually identical.
const CHIP_BASE_CLASS = cn(
  "inline-flex max-w-full items-center gap-1 align-middle",
  "bg-muted/60 rounded-md border px-1.5 py-0.5",
  "text-foreground text-xs font-medium",
);

const ChipIcon = ({ source }: { source: PastedTextSource }) => {
  const className = "text-muted-foreground size-3 shrink-0";
  if (source === "skill") {
    return <WandSparklesIcon className={className} />;
  }
  if (source === "prompt") {
    return <SparklesIcon className={className} />;
  }
  if (source === "command") {
    return <CommandIcon className={className} />;
  }
  return <ClipboardPasteIcon className={className} />;
};

const PASTED_TEXT_SOURCE_VALUES: ReadonlySet<string> = new Set([
  "paste",
  "prompt",
  "skill",
  "command",
]);

const isPastedTextSource = (value: unknown): value is PastedTextSource =>
  typeof value === "string" && PASTED_TEXT_SOURCE_VALUES.has(value);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const readPastedTextAttrs = (value: unknown): PastedTextAttrs => {
  if (!isRecord(value)) {
    return { text: "", label: "", source: "paste" };
  }

  const text = value["text"];
  const label = value["label"];
  const source = value["source"];

  return {
    text: typeof text === "string" ? text : "",
    label: typeof label === "string" ? label : "",
    source: isPastedTextSource(source) ? source : "paste",
  };
};

export const ChatPastedTextNode = (props: NodeViewProps) => {
  const t = useTranslations();
  const attrs = readPastedTextAttrs(props.node.attrs);

  // Local-state-only edits keep the textarea responsive on large
  // pastes; we commit back to the node attrs on blur (which fires
  // when the popover closes), so each keystroke doesn't dispatch a
  // ProseMirror transaction + draft re-sync.
  const [draftText, setDraftText] = useState(attrs.text);
  // Reset the editable draft when the node attr changes upstream (undo/redo,
  // external edits) using React's adjust-state-during-render pattern instead of
  // a reset effect: track the last attr value and re-seed the draft when it
  // diverges. Local textarea edits keep attrs.text === lastAttrText until blur
  // commits, so in-progress edits are preserved.
  const [lastAttrText, setLastAttrText] = useState(attrs.text);
  if (attrs.text !== lastAttrText) {
    setLastAttrText(attrs.text);
    setDraftText(attrs.text);
  }
  const commitDraft = () => {
    if (draftText !== attrs.text) {
      props.updateAttributes({ text: draftText });
    }
  };

  const fallbackLabel =
    attrs.source === "prompt" || attrs.source === "skill"
      ? t("chat.pastedText.fromPromptFallback")
      : t("chat.pastedText.fromClipboard", {
          count: attrs.text.length,
        });
  const chipLabel = attrs.label.length > 0 ? attrs.label : fallbackLabel;

  // Reserved slash commands (`/new`, `/model`) are action triggers, not
  // editable content, so they render as a static chip without the expand/edit
  // popover the other sources use.
  if (attrs.source === "command") {
    return (
      <NodeViewWrapper className="inline" data-source="command">
        <span
          className={cn(CHIP_BASE_CLASS, "select-none")}
          contentEditable={false}
        >
          <ChipIcon source={attrs.source} />
          <span className={cn("truncate", CHIP_MAX_LABEL_WIDTH_CLASS)}>
            {chipLabel}
          </span>
        </span>
      </NodeViewWrapper>
    );
  }

  return (
    <NodeViewWrapper className="inline" data-source={attrs.source}>
      <Popover>
        <PopoverTrigger
          aria-label={t("chat.pastedText.expand")}
          className={cn(
            CHIP_BASE_CLASS,
            "hover:bg-muted",
            "focus-visible:ring-ring transition-colors focus-visible:ring-2 focus-visible:outline-none",
            "cursor-pointer select-none",
          )}
          contentEditable={false}
          type="button"
        >
          <ChipIcon source={attrs.source} />
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
                aria-label={t("common.remove")}
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
              dir={contentDir(draftText)}
              onBlur={commitDraft}
              onChange={(event) => {
                setDraftText(event.target.value);
              }}
              spellCheck={false}
              value={draftText}
            />
          </div>
        </PopoverPopup>
      </Popover>
    </NodeViewWrapper>
  );
};
