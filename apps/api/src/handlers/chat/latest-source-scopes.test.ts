import { describe, expect, it } from "bun:test";

import { createChatPastedTextPart } from "@stll/api-contract/chat";

import { sourceScopesOfLatestUserMessage } from "@/api/handlers/chat/latest-source-scopes";
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

describe("sourceScopesOfLatestUserMessage", () => {
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

    expect(sourceScopesOfLatestUserMessage(messages)).toEqual([
      { kind: "corpus", corpus: "case_law", country: "CZE" },
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

    expect(sourceScopesOfLatestUserMessage(messages)).toEqual([
      { kind: "corpus", corpus: "case_law", country: "CZE" },
      { kind: "corpus", corpus: "legislation", country: "SVK" },
    ]);
  });

  it("reads no chips from pasted text or an unscoped latest message", () => {
    expect(
      sourceScopesOfLatestUserMessage([
        user(createChatPastedTextPart("[A](#stella-corpus=case_law:CZE)")),
      ]),
    ).toEqual([]);
    expect(
      sourceScopesOfLatestUserMessage([
        user(text("[A](#stella-corpus=case_law:CZE)")),
        user(text("No chip this time")),
      ]),
    ).toEqual([]);
    expect(sourceScopesOfLatestUserMessage([])).toEqual([]);
  });

  it("reads registry and connector chips beside corpus chips", () => {
    const messages = [
      user(
        text(
          "[ARES](#stella-registry=ares) [CZ](#stella-corpus=case_law:CZE) " +
            "[GLS](#stella-connector=global-legal-search) " +
            "[ARES again](#stella-registry=ares) [bad](#stella-registry=nope)",
        ),
      ),
    ];

    expect(sourceScopesOfLatestUserMessage(messages)).toEqual([
      { kind: "registry", registry: "ares" },
      { kind: "corpus", corpus: "case_law", country: "CZE" },
      { kind: "connector", connector: "global-legal-search" },
    ]);
  });
});
