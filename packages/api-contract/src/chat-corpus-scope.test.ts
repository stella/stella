import { describe, expect, test } from "bun:test";

import { formatChatCorpusId, parseChatCorpusId } from "./chat-corpus-scope";

describe("chat corpus chip ids", () => {
  test("round-trip every corpus", () => {
    for (const scope of [
      { corpus: "case_law", country: "CZE" },
      { corpus: "legislation", country: "SVK" },
    ] as const) {
      expect(parseChatCorpusId(formatChatCorpusId(scope))).toEqual(scope);
    }
  });

  test.each([
    "",
    "case_law",
    "case_law:",
    "case_law:cze",
    "case_law:XXX",
    "registry:CZE",
    "case_law:CZE:extra",
  ])("rejects %p", (id) => {
    expect(parseChatCorpusId(id)).toBeNull();
  });
});
