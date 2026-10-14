import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, beforeEach, describe, expect, test } from "bun:test";

import type { ChatThreadId } from "@/lib/chat-thread-ref";

GlobalRegistrator.register({ url: "https://app.example.test" });

const { askPublicLawInChat } = await import("@/components/public-law-ask");
const { useInspectorTabsStore } =
  await import("@/components/inspector/inspector-tabs-store");
const { mentionTagAttrs, referenceFromMentionAttrs } =
  await import("@/components/references/reference.logic");
const { claimQueuedChatSend } =
  await import("@/features/chat/queued-chat-sends");

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

const ASK = {
  label: "kdy je možné vyhodit zaměstnance?",
  question: "kdy je možné vyhodit <b>zaměstnance</b>?",
  scope: { corpus: "case_law", country: "CZE" },
  scopeLabel: "Case law · Czechia",
} as const;

const openedThreadIds = () =>
  useInspectorTabsStore
    .getState()
    .tabs.flatMap((tab) => (tab.type === "chat" ? [tab.id] : []));

const claim = (threadId: ChatThreadId) =>
  claimQueuedChatSend({ scope: "global", threadId });

beforeEach(() => {
  useInspectorTabsStore.setState({ tabs: [] });
});

describe("asking a search's question in chat", () => {
  test("opens a chat that sends the question once, behind the corpus chip", () => {
    askPublicLawInChat(ASK);

    const [threadId] = openedThreadIds();
    if (threadId === undefined) {
      throw new Error("Expected a chat tab");
    }
    const html = claim(threadId);
    expect(claim(threadId)).toBeNull();

    const message = document.createElement("div");
    // safe-html: the message this test just built through the DOM
    message.innerHTML = html ?? "";
    const chip = message.querySelector("entity-mention");
    if (chip === null) {
      throw new Error("Expected the corpus chip");
    }
    expect(
      referenceFromMentionAttrs(
        mentionTagAttrs((name) => chip.getAttribute(name)),
      ),
    ).toEqual({
      type: "corpus",
      scope: ASK.scope,
      label: ASK.scopeLabel,
    });
    // The reader's text stays text: no markup of theirs reaches the message.
    expect(message.querySelector("b")).toBeNull();
    expect(message.textContent).toBe(` ${ASK.question}`);
  });

  test("a second press before the chat opened joins the same thread", () => {
    askPublicLawInChat(ASK);
    askPublicLawInChat(ASK);

    const threadIds = openedThreadIds();
    expect(new Set(threadIds).size).toBe(1);
    const [threadId] = threadIds;
    expect(threadId === undefined ? null : claim(threadId)).not.toBeNull();
  });
});
