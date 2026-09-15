import { describe, expect, test } from "bun:test";

import {
  decisionChatKey,
  LEGAL_DOCUMENT_CHAT_CORPUS,
  isOptionalLegalDocumentChatKey,
  parseLegalDocumentChatKey,
  statuteChatKey,
} from "./legal-document-chat-key";

describe("the key a legal document's conversation is filed under", () => {
  test("keeps the corpora apart when their ids agree", () => {
    expect(decisionChatKey("x")).not.toBe(statuteChatKey("x"));
  });

  test("reads back as the document it was built from", () => {
    expect(parseLegalDocumentChatKey(decisionChatKey("decision-1"))).toEqual({
      corpus: "decision",
      id: "decision-1",
    });
    expect(parseLegalDocumentChatKey(statuteChatKey("doc-1"))).toEqual({
      corpus: "statute",
      id: "doc-1",
    });
  });

  test("keeps an id that contains the separator whole", () => {
    expect(
      parseLegalDocumentChatKey(statuteChatKey("eli:cz/sb/1964/40")),
    ).toEqual({ corpus: "statute", id: "eli:cz/sb/1964/40" });
  });

  test("is not a key when the corpus is unknown, the id empty, or the value not a string", () => {
    expect(parseLegalDocumentChatKey("ruling:1")).toBeNull();
    expect(parseLegalDocumentChatKey("decision:")).toBeNull();
    expect(parseLegalDocumentChatKey("decision-1")).toBeNull();
    expect(parseLegalDocumentChatKey(undefined)).toBeNull();
    expect(parseLegalDocumentChatKey(7)).toBeNull();
  });

  // A value one character longer than its corpus used to lose that character
  // to a slice at index -1 and read as a well-formed key of that corpus.
  test("is not a key when the separator is missing entirely", () => {
    for (const corpus of Object.keys(LEGAL_DOCUMENT_CHAT_CORPUS)) {
      expect(parseLegalDocumentChatKey(corpus)).toBeNull();
      expect(parseLegalDocumentChatKey(`${corpus}X`)).toBeNull();
      expect(parseLegalDocumentChatKey(`${corpus}-1`)).toBeNull();
    }
  });
});

describe("a tab field carrying the key", () => {
  test("accepts a well-formed key and an absent one", () => {
    expect(isOptionalLegalDocumentChatKey(undefined)).toBe(true);
    expect(isOptionalLegalDocumentChatKey(decisionChatKey("d"))).toBe(true);
  });

  test("rejects anything else a foreign window could broadcast", () => {
    expect(isOptionalLegalDocumentChatKey(null)).toBe(false);
    expect(isOptionalLegalDocumentChatKey("decision-1")).toBe(false);
    expect(isOptionalLegalDocumentChatKey({})).toBe(false);
  });
});
