import type { PastedTextAttrs } from "@/components/chat-pasted-text-extension";
import type { ChatThreadRef } from "@/lib/chat-thread-ref";

/**
 * The chat a transcript belongs to, as a chat branched from it needs it: the
 * thread (whose composer a quote can go to) and the matters it is scoped to,
 * which a new chat opened from it inherits.
 */
export type ChatBranchSource = {
  contextMatterIds: readonly string[];
  threadRef: ChatThreadRef;
};

export const CHAT_SELECTION_ACTION = {
  askInNewChat: "askInNewChat",
  copy: "copy",
  quoteInReply: "quoteInReply",
} as const;
export type ChatSelectionAction =
  (typeof CHAT_SELECTION_ACTION)[keyof typeof CHAT_SELECTION_ACTION];

/**
 * The words selected in a chat message, as a quotation should hold them:
 * runs of spaces and tabs folded, every line trimmed, blank lines dropped.
 * Line breaks survive, so a selected list or two paragraphs stay apart.
 */
export const normalizeChatSelectionText = (raw: string): string =>
  raw
    .split(/\r?\n/u)
    .map((line) => line.replaceAll(/[^\S\n]+/gu, " ").trim())
    .filter((line) => line !== "")
    .join("\n");

/**
 * The composer chip a quotation travels as. The chip shows the opening words
 * in quotation marks (it truncates the rest), and its text carries the marks
 * too: the chip reaches the model as bare text, so without them the quote
 * would run straight into the question typed after it. `quoted` wraps a
 * string in the locale's quotation marks.
 */
export const chatQuoteChip = ({
  quote,
  quoted,
}: {
  quote: string;
  quoted: (text: string) => string;
}): PastedTextAttrs => ({
  label: quoted(quote.replaceAll(/\s+/gu, " ")),
  source: "paste",
  text: quoted(quote),
});

/**
 * What the selection toolbar offers, in order: the primary action first.
 * Asking in a new chat and quoting in the reply both need the chat the words
 * came from; a transcript rendered without one can still copy them.
 */
export const chatSelectionActions = ({
  quote,
  source,
}: {
  quote: string;
  source: ChatBranchSource | null;
}): ChatSelectionAction[] => {
  if (quote === "") {
    return [];
  }
  if (source === null) {
    return [CHAT_SELECTION_ACTION.copy];
  }
  return [
    CHAT_SELECTION_ACTION.askInNewChat,
    CHAT_SELECTION_ACTION.quoteInReply,
    CHAT_SELECTION_ACTION.copy,
  ];
};
