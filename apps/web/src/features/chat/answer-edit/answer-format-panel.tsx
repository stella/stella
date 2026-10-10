import { useState } from "react";

import { panic } from "better-result";
import { useTranslations } from "use-intl";
import * as v from "valibot";

import {
  CHAT_MESSAGE_EDIT_FORMAT,
  CHAT_MESSAGE_EDIT_STYLES,
} from "@stll/api-contract/chat-message-revisions";
import { Button } from "@stll/ui/button";
import { BoldIcon, ItalicIcon, LinkIcon, TextIcon } from "@stll/ui/icons";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@stll/ui/select";

import { useLatestCallback } from "@/hooks/use-latest-callback";
import type { TranslationKey } from "@/i18n/types";

import type { AnswerEditAnchor } from "./answer-edit-api";
import type { AnswerSourceSelection } from "./answer-edit-selection";
import { AnswerFormatProposal } from "./answer-format-proposal";
import { AnswerLinkForm } from "./answer-link-form";
import { selectedMarkdownLinkUrl } from "./markdown-format.logic";
import type { AnswerFormatAction } from "./markdown-format.logic";

export const AnswerFormatPanel = ({
  entry,
  anchor,
  selection,
  threadId,
  disabled,
  onCancel,
  onAnswerEdited,
}: AnswerFormatPanelProps) => {
  const t = useTranslations();
  const [action, setAction] = useState<AnswerFormatAction | null>(
    entry === "bold" || entry === "italic" ? { format: entry } : null,
  );
  const onKeyDown = useLatestCallback((event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onCancel();
    }
  });
  if (action === null) {
    if (entry === "link") {
      return (
        <AnswerLinkForm
          existingUrl={selectedMarkdownLinkUrl({
            source: selection.source,
            start: selection.start,
            end: selection.end,
          })}
          onAction={setAction}
          onCancel={onCancel}
          disabled={disabled}
        />
      );
    }
    return (
      <div
        className="w-80 space-y-2 p-2"
        role="dialog"
        aria-label={t("chat.answerEdit.textStyle")}
        tabIndex={-1}
        ref={(node) => {
          if (node === null) {
            return undefined;
          }
          node.focus();
          node.addEventListener("keydown", onKeyDown);
          return () => node.removeEventListener("keydown", onKeyDown);
        }}
      >
        <Select
          disabled={disabled}
          onValueChange={(value) => {
            if (v.is(v.picklist(CHAT_MESSAGE_EDIT_STYLES), value)) {
              setAction({ format: "style", style: value });
            }
          }}
        >
          <SelectTrigger aria-label={t("chat.answerEdit.textStyle")}>
            <SelectValue placeholder={t("chat.answerEdit.textStyle")} />
          </SelectTrigger>
          <SelectPopup>
            {CHAT_MESSAGE_EDIT_STYLES.map((style) => (
              <SelectItem key={style} value={style}>
                {t(ANSWER_STYLE_LABEL_KEYS[style], { level: style.slice(-1) })}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          {t("common.cancel")}
        </Button>
      </div>
    );
  }
  return (
    <AnswerFormatProposal
      anchor={anchor}
      selection={selection}
      action={action}
      threadId={threadId}
      disabled={disabled}
      onCancel={onCancel}
      onAnswerEdited={onAnswerEdited}
    />
  );
};

export const AnswerFormattingControls = ({
  disabled,
  onSelect,
}: {
  disabled: boolean;
  onSelect: (entry: AnswerFormatEntry) => void;
}) => {
  const t = useTranslations();
  return (
    <>
      {ANSWER_FORMAT_ENTRIES.map((entry) => (
        <Button
          key={entry}
          size="icon-sm"
          variant="ghost"
          disabled={disabled}
          aria-label={t(ANSWER_FORMAT_LABEL_KEYS[entry])}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => onSelect(entry)}
        >
          {(() => {
            switch (entry) {
              case "bold":
                return <BoldIcon />;
              case "italic":
                return <ItalicIcon />;
              case "link":
                return <LinkIcon />;
              case "style":
                return <TextIcon />;
              default:
                entry satisfies never;
                return panic("Unhandled answer format");
            }
          })()}
        </Button>
      ))}
    </>
  );
};

const ANSWER_FORMAT_ENTRIES = Object.values(CHAT_MESSAGE_EDIT_FORMAT);
export type AnswerFormatEntry = (typeof ANSWER_FORMAT_ENTRIES)[number];
export type AnswerFormatPanelProps = {
  entry: AnswerFormatEntry;
  anchor: AnswerEditAnchor;
  selection: AnswerSourceSelection;
  threadId: string;
  disabled: boolean;
  onCancel: () => void;
  onAnswerEdited: () => Promise<void>;
};

const ANSWER_FORMAT_LABEL_KEYS = {
  bold: "folio.bold",
  italic: "folio.italic",
  link: "chat.answerEdit.linkAddress",
  style: "chat.answerEdit.textStyle",
} as const satisfies Record<AnswerFormatEntry, TranslationKey>;

const ANSWER_STYLE_LABEL_KEYS = {
  paragraph: "bilingualTranslate.kinds.paragraph",
  "ordered-list": "chat.answerEdit.orderedList",
  "unordered-list": "chat.answerEdit.unorderedList",
  "heading-1": "chat.answerEdit.heading",
  "heading-2": "chat.answerEdit.heading",
  "heading-3": "chat.answerEdit.heading",
  "heading-4": "chat.answerEdit.heading",
  "heading-5": "chat.answerEdit.heading",
  "heading-6": "chat.answerEdit.heading",
} as const satisfies Record<
  (typeof CHAT_MESSAGE_EDIT_STYLES)[number],
  TranslationKey
>;
