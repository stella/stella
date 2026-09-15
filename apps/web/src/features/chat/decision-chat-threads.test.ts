import { beforeEach, describe, expect, test } from "bun:test";

import { toChatThreadId } from "@/lib/chat-thread-ref";

import {
  adoptDecisionChatThread,
  ensureDecisionChatThread,
  lookupDecisionChatThread,
  useDecisionChatThreads,
} from "./decision-chat-threads";

const DECISION = "decision-1";
const OTHER_DECISION = "decision-2";
const TAB_THREAD = toChatThreadId("thread-from-a-tab");
const NAMED_THREAD = toChatThreadId("thread-the-user-named");

beforeEach(() => {
  useDecisionChatThreads.setState({ threadIdByDecisionId: {} });
});

describe("a decision's conversation", () => {
  test("is unknown until a surface asks for it", () => {
    expect(lookupDecisionChatThread(DECISION)).toEqual({ status: "none" });
  });

  test("is the same thread for every surface that asks", () => {
    const first = ensureDecisionChatThread({ decisionId: DECISION });
    const second = ensureDecisionChatThread({ decisionId: DECISION });

    expect(second).toBe(first);
    expect(lookupDecisionChatThread(DECISION)).toEqual({
      status: "thread",
      threadId: first,
    });
  });

  test("is separate per decision", () => {
    const first = ensureDecisionChatThread({ decisionId: DECISION });
    const second = ensureDecisionChatThread({ decisionId: OTHER_DECISION });

    expect(second).not.toBe(first);
  });

  test("continues a thread a restored tab already owns", () => {
    const resolved = ensureDecisionChatThread({
      adoptThreadId: TAB_THREAD,
      decisionId: DECISION,
    });

    expect(resolved).toBe(TAB_THREAD);
  });

  test("keeps the thread it already knows when a tab offers another", () => {
    const owned = ensureDecisionChatThread({ decisionId: DECISION });
    const resolved = ensureDecisionChatThread({
      adoptThreadId: TAB_THREAD,
      decisionId: DECISION,
    });

    expect(resolved).toBe(owned);
    expect(resolved).not.toBe(TAB_THREAD);
  });

  test("moves to a thread the user names, and stays there", () => {
    const owned = ensureDecisionChatThread({ decisionId: DECISION });
    adoptDecisionChatThread({ decisionId: DECISION, threadId: NAMED_THREAD });

    expect(owned).not.toBe(NAMED_THREAD);
    expect(ensureDecisionChatThread({ decisionId: DECISION })).toBe(
      NAMED_THREAD,
    );
  });

  test("leaves other decisions where they were when one moves", () => {
    const untouched = ensureDecisionChatThread({
      decisionId: OTHER_DECISION,
    });
    adoptDecisionChatThread({ decisionId: DECISION, threadId: NAMED_THREAD });

    expect(lookupDecisionChatThread(OTHER_DECISION)).toEqual({
      status: "thread",
      threadId: untouched,
    });
  });

  test("does not churn subscribers when a surface re-adopts what it has", () => {
    adoptDecisionChatThread({ decisionId: DECISION, threadId: NAMED_THREAD });
    const before = useDecisionChatThreads.getState();
    adoptDecisionChatThread({ decisionId: DECISION, threadId: NAMED_THREAD });

    expect(useDecisionChatThreads.getState()).toBe(before);
  });
});
