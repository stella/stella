import { beforeEach, describe, expect, test } from "bun:test";

import { toChatThreadId } from "@/lib/chat-thread-ref";

import { decisionChatKey, statuteChatKey } from "./legal-document-chat-key";
import {
  adoptLegalDocumentChatThread,
  ensureLegalDocumentChatThread,
  lookupLegalDocumentChatThread,
  useLegalDocumentChatThreads,
} from "./legal-document-chat-threads";

const DECISION = decisionChatKey("decision-1");
const OTHER_DECISION = decisionChatKey("decision-2");
const STATUTE = statuteChatKey("decision-1");
const TAB_THREAD = toChatThreadId("thread-from-a-tab");
const NAMED_THREAD = toChatThreadId("thread-the-user-named");

beforeEach(() => {
  useLegalDocumentChatThreads.setState({ threadIdByDocumentKey: {} });
});

describe("a legal document's conversation", () => {
  test("is unknown until a surface asks for it", () => {
    expect(lookupLegalDocumentChatThread(DECISION)).toEqual({ status: "none" });
  });

  test("is the same thread for every surface that asks", () => {
    const first = ensureLegalDocumentChatThread({ documentKey: DECISION });
    const second = ensureLegalDocumentChatThread({ documentKey: DECISION });

    expect(second).toBe(first);
    expect(lookupLegalDocumentChatThread(DECISION)).toEqual({
      status: "thread",
      threadId: first,
    });
  });

  test("is separate per document", () => {
    const first = ensureLegalDocumentChatThread({ documentKey: DECISION });
    const second = ensureLegalDocumentChatThread({
      documentKey: OTHER_DECISION,
    });

    expect(second).not.toBe(first);
  });

  test("is separate per corpus, even where the two ids agree", () => {
    const decision = ensureLegalDocumentChatThread({ documentKey: DECISION });
    const statute = ensureLegalDocumentChatThread({ documentKey: STATUTE });

    expect(statute).not.toBe(decision);
  });

  test("continues a thread a restored tab already owns", () => {
    const resolved = ensureLegalDocumentChatThread({
      adoptThreadId: TAB_THREAD,
      documentKey: STATUTE,
    });

    expect(resolved).toBe(TAB_THREAD);
  });

  test("keeps the thread it already knows when a tab offers another", () => {
    const owned = ensureLegalDocumentChatThread({ documentKey: DECISION });
    const resolved = ensureLegalDocumentChatThread({
      adoptThreadId: TAB_THREAD,
      documentKey: DECISION,
    });

    expect(resolved).toBe(owned);
    expect(resolved).not.toBe(TAB_THREAD);
  });

  test("moves to a thread the user names, and stays there", () => {
    const owned = ensureLegalDocumentChatThread({ documentKey: STATUTE });
    adoptLegalDocumentChatThread({
      documentKey: STATUTE,
      threadId: NAMED_THREAD,
    });

    expect(owned).not.toBe(NAMED_THREAD);
    expect(ensureLegalDocumentChatThread({ documentKey: STATUTE })).toBe(
      NAMED_THREAD,
    );
  });

  test("leaves other documents where they were when one moves", () => {
    const untouched = ensureLegalDocumentChatThread({
      documentKey: OTHER_DECISION,
    });
    adoptLegalDocumentChatThread({
      documentKey: DECISION,
      threadId: NAMED_THREAD,
    });

    expect(lookupLegalDocumentChatThread(OTHER_DECISION)).toEqual({
      status: "thread",
      threadId: untouched,
    });
  });

  test("does not churn subscribers when a surface re-adopts what it has", () => {
    adoptLegalDocumentChatThread({
      documentKey: DECISION,
      threadId: NAMED_THREAD,
    });
    const before = useLegalDocumentChatThreads.getState();
    adoptLegalDocumentChatThread({
      documentKey: DECISION,
      threadId: NAMED_THREAD,
    });

    expect(useLegalDocumentChatThreads.getState()).toBe(before);
  });
});
