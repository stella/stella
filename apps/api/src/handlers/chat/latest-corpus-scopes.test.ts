import { describe, expect, it } from "bun:test";

import { createChatPastedTextPart } from "@stll/api-contract/chat";

import { corpusScopesOfLatestUserMessage } from "@/api/handlers/chat/latest-corpus-scopes";
import type {
  ChatPart,
  PersistableChatMessage,
} from "@/api/handlers/chat/types";

type Message = Pick<PersistableChatMessage, "parts" | "role">;

const text = (content: string): ChatPart => ({ type: "text", content });

const user = (...parts: ChatPart[]): Message => ({ role: "user", parts });
const assistant = (content: string): Message => ({
  role: "assistant",
  parts: [text(content)],
});

describe("corpusScopesOfLatestUserMessage", () => {
  it("keeps an approval continuation scoped to the chips of the last user message", () => {
    const messages = [
      user(
        text("Earlier [Legislation · Czechia](#stella-corpus=legislation:CZE)"),
      ),
      assistant("Done."),
      user(
        text(
          "Ask [Case law · Czechia](#stella-corpus=case_law:CZE) about leases",
        ),
      ),
      // The continuation's own message is the assistant's, awaiting approval.
      assistant("Searching [x](#stella-corpus=case_law:SVK)"),
    ];

    expect(corpusScopesOfLatestUserMessage(messages)).toEqual([
      { corpus: "case_law", country: "CZE" },
    ]);
  });

  it("dedupes chips and ignores other links and invalid ids", () => {
    const messages = [
      user(
        text(
          "[A](#stella-corpus=case_law:CZE) [B](#stella-corpus=case_law:CZE) " +
            "[C](#stella-corpus=case_law:XXX) [D](https://example.com) " +
            "[E](#stella-corpus=legislation:SVK)",
        ),
      ),
    ];

    expect(corpusScopesOfLatestUserMessage(messages)).toEqual([
      { corpus: "case_law", country: "CZE" },
      { corpus: "legislation", country: "SVK" },
    ]);
  });

  it.each([
    ["an inline code span", "`[x](#stella-corpus=case_law:CZE)`"],
    [
      "a multi-backtick inline code span",
      "`` `[x](#stella-corpus=case_law:CZE)` ``",
    ],
    [
      "a backtick fenced code block",
      "```md\n[x](#stella-corpus=case_law:CZE)\n```",
    ],
    [
      "a tilde fenced code block",
      "~~~ markdown\n[x](#stella-corpus=case_law:CZE)\n~~~",
    ],
    [
      "an unterminated fenced code block",
      "before\n```md\n[x](#stella-corpus=case_law:CZE)",
    ],
    ["an indented code block", "    [x](#stella-corpus=case_law:CZE)"],
    [
      "an escaped opening bracket",
      String.raw`\[x](#stella-corpus=case_law:CZE)`,
    ],
  ])("ignores a corpus link only inside %s", (_, markdown) => {
    expect(corpusScopesOfLatestUserMessage([user(text(markdown))])).toEqual([]);
  });

  it("keeps a rendered link next to a corpus link in a code span", () => {
    const markdown =
      "`[ignored](#stella-corpus=case_law:CZE)` " +
      "[Legislation](#stella-corpus=legislation:SVK)";

    expect(corpusScopesOfLatestUserMessage([user(text(markdown))])).toEqual([
      { corpus: "legislation", country: "SVK" },
    ]);
  });

  it("reads corpus scopes from rendered reference links", () => {
    const markdown =
      "Ask [Case law][scope].\n\n[scope]: #stella-corpus=case_law:CZE";

    expect(corpusScopesOfLatestUserMessage([user(text(markdown))])).toEqual([
      { corpus: "case_law", country: "CZE" },
    ]);
  });

  it("reads no chips from pasted text or an unscoped latest message", () => {
    expect(
      corpusScopesOfLatestUserMessage([
        user(createChatPastedTextPart("[A](#stella-corpus=case_law:CZE)")),
      ]),
    ).toEqual([]);
    expect(
      corpusScopesOfLatestUserMessage([
        user(text("[A](#stella-corpus=case_law:CZE)")),
        user(text("No chip this time")),
      ]),
    ).toEqual([]);
    expect(corpusScopesOfLatestUserMessage([])).toEqual([]);
  });
});
