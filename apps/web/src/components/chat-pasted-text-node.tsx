import { useState } from "react";

import { NodeViewWrapper } from "@tiptap/react";
import type { NodeViewProps } from "@tiptap/react";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { CommandIcon, XIcon } from "@stll/ui/icons";
import { Popover, PopoverPopup, PopoverTrigger } from "@stll/ui/popover";
import { contentDir } from "@stll/ui/use-content-dir";
import { cn } from "@stll/ui/utils";

import type {
  PastedTextAttrs,
  PastedTextSource,
} from "@/components/chat-pasted-text-extension";
import { ChatAttachmentChip } from "@/components/chat/chat-draft-attachment-chips";
import { ReferenceChip } from "@/components/references/reference-chip";

const CHIP_MAX_LABEL_WIDTH_CLASS = "max-w-48";

// Shared chip shell so the interactive paste trigger and the
// static command chip stay visually identical.
const CHIP_BASE_CLASS = cn(
  "inline-flex max-w-full items-center gap-1 align-middle",
  "bg-muted/60 rounded-md border px-1.5 py-0.5",
  "text-foreground text-xs font-medium",
);

const PASTED_TEXT_SOURCE_VALUES: readonly string[] = [
  "paste",
  "prompt",
  "skill",
  "command",
];

const isPastedTextSource = (value: unknown): value is PastedTextSource =>
  typeof value === "string" &&
  PASTED_TEXT_SOURCE_VALUES.some((source) => source === value);

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

  // Reserved slash commands such as `/new` are action triggers, not
  // editable content, so they render as a static chip without the expand/edit
  // popover the other sources use.
  if (attrs.source === "command") {
    return (
      <NodeViewWrapper className="inline" data-source="command">
        <span
          className={cn(CHIP_BASE_CLASS, "select-none")}
          contentEditable={false}
        >
          <CommandIcon className="text-muted-foreground size-3 shrink-0" />
          <span className={cn("truncate", CHIP_MAX_LABEL_WIDTH_CLASS)}>
            {chipLabel}
          </span>
        </span>
      </NodeViewWrapper>
    );
  }

  if (attrs.source === "paste") {
    return (
      <NodeViewWrapper
        className="inline"
        contentEditable={false}
        data-source={attrs.source}
      >
        <ChatAttachmentChip
          behavior={{
            type: "draft",
            onRemove: () => {
              props.deleteNode();
              props.editor.commands.focus();
            },
            onExpand: () => {
              const position = props.getPos();
              if (position === undefined) {
                return;
              }
              props.editor
                .chain()
                .focus()
                .insertContentAt(
                  { from: position, to: position + props.node.nodeSize },
                  { type: "text", text: attrs.text },
                  { applyInputRules: false, applyPasteRules: false },
                )
                .run();
            },
          }}
          item={{
            type: "pasted_text",
            id: "inline-pasted-text",
            text: attrs.text,
          }}
        />
      </NodeViewWrapper>
    );
  }

  return (
    <NodeViewWrapper className="inline" data-source={attrs.source}>
      <Popover>
        <PopoverTrigger
          aria-label={t("chat.pastedText.expand")}
          className="inline-flex max-w-full cursor-pointer align-middle select-none"
          contentEditable={false}
          type="button"
        >
          <ReferenceChip
            interactive={false}
            reference={{
              type: "skill",
              slug: attrs.source === "skill" ? attrs.text : "",
              label: chipLabel,
            }}
            selected={props.selected}
          />
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
              className="bg-muted/40 focus-visible:ring-ring text-2xs max-h-60 min-h-32 resize-none overflow-auto rounded-md border p-2 font-mono whitespace-pre-wrap focus-visible:ring-2 focus-visible:outline-none"
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
