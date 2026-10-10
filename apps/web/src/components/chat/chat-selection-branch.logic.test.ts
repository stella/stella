import { describe, expect, test } from "bun:test";

import {
  CHAT_SELECTION_ACTION,
  chatQuoteChip,
  chatSelectionActions,
  normalizeChatSelectionText,
} from "@/components/chat/chat-selection-branch.logic";
import type { ChatBranchSource } from "@/components/chat/chat-selection-branch.logic";
import { toChatThreadId } from "@/lib/chat-thread-ref";

const source: ChatBranchSource = {
  contextMatterIds: ["matter-1"],
  threadRef: {
    scope: "workspace",
    threadId: toChatThreadId("thread-1"),
    workspaceId: "matter-1",
  },
};

const czechQuoted = (text: string) => `„${text}“`;

describe("normalizeChatSelectionText", () => {
  test("folds runs of spaces and tabs and trims each line", () => {
    expect(normalizeChatSelectionText("  The   tenant\tshall pay  ")).toBe(
      "The tenant shall pay",
    );
  });

  test("keeps line breaks between paragraphs and drops blank lines", () => {
    expect(
      normalizeChatSelectionText("First point.\n\n\n  Second point.\r\n"),
    ).toBe("First point.\nSecond point.");
  });

  test("whitespace alone is no selection", () => {
    expect(normalizeChatSelectionText(" \n\t \n")).toBe("");
  });
});

describe("chatQuoteChip", () => {
  test("quotes the words in the locale's marks, in the label and the text", () => {
    expect(
      chatQuoteChip({
        quote: "Lhůta je 15 dnů.\nOd doručení.",
        quoted: czechQuoted,
      }),
    ).toEqual({
      label: "„Lhůta je 15 dnů. Od doručení.“",
      source: "paste",
      text: "„Lhůta je 15 dnů.\nOd doručení.“",
    });
  });
});

describe("chatSelectionActions", () => {
  test("offers asking in a new chat first, then quoting, then copying", () => {
    expect(chatSelectionActions({ quote: "the clause", source })).toEqual([
      CHAT_SELECTION_ACTION.askInNewChat,
      CHAT_SELECTION_ACTION.quoteInReply,
      CHAT_SELECTION_ACTION.copy,
    ]);
  });

  test("offers both chat actions in a global chat too", () => {
    expect(
      chatSelectionActions({
        quote: "the clause",
        source: {
          contextMatterIds: [],
          threadRef: { scope: "global", threadId: toChatThreadId("t-2") },
        },
      }),
    ).toContain(CHAT_SELECTION_ACTION.askInNewChat);
  });

  test("without a source chat only copying is left", () => {
    expect(chatSelectionActions({ quote: "the clause", source: null })).toEqual(
      [CHAT_SELECTION_ACTION.copy],
    );
  });

  test("an empty selection offers nothing", () => {
    expect(chatSelectionActions({ quote: "", source })).toEqual([]);
  });
});
