import { describe, expect, test } from "bun:test";

import { legalDocumentChatContext } from "./legal-document-chat-context";
import { decisionChatKey, statuteChatKey } from "./legal-document-chat-key";
import type { LegalDocumentChatKey } from "./legal-document-chat-key";

const DECISION = decisionChatKey("decision-1");
const STATUTE = statuteChatKey("document-1");

const contextFor = (
  documentKey: LegalDocumentChatKey,
  readDocumentKey: () => LegalDocumentChatKey | undefined = () => documentKey,
) => legalDocumentChatContext({ documentKey, readDocumentKey });

describe("the capability a bound legal document travels by", () => {
  test("is the decision field, carrying the decision's own id", () => {
    const context = contextFor(DECISION);

    expect(context.getActiveStatute).toBeUndefined();
    expect(context.getActiveDecision?.()).toEqual({ decisionId: "decision-1" });
  });

  test("is the statute field, carrying the consolidation's own id", () => {
    const context = contextFor(STATUTE);

    expect(context.getActiveDecision).toBeUndefined();
    expect(context.getActiveStatute?.()).toEqual({ documentId: "document-1" });
  });

  test("sends the document the surface shows now, not the one it was built on", () => {
    const context = contextFor(DECISION, () => decisionChatKey("decision-2"));

    expect(context.getActiveDecision?.()).toEqual({ decisionId: "decision-2" });
  });

  test("sends nothing once the surface has moved to another corpus", () => {
    expect(
      contextFor(DECISION, () => STATUTE).getActiveDecision?.(),
    ).toBeUndefined();
    expect(
      contextFor(STATUTE, () => DECISION).getActiveStatute?.(),
    ).toBeUndefined();
  });

  test("sends nothing once the surface is bound to no document at all", () => {
    expect(
      contextFor(STATUTE, () => undefined).getActiveStatute?.(),
    ).toBeUndefined();
  });
});
