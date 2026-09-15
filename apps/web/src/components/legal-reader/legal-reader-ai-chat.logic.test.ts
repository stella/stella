import { describe, expect, test } from "bun:test";

import type { InspectorTab } from "@/components/inspector/inspector-store-types";
import { toChatThreadId } from "@/lib/chat-thread-ref";

import {
  activeChatTabThreadId,
  decisionChatTabThreadId,
  overlayThreadCardVisibility,
} from "./legal-reader-ai-chat.logic";

const DECISION = "decision-1";
const THREAD = toChatThreadId("thread-1");
const OTHER_THREAD = toChatThreadId("thread-2");

const chatTab = ({
  activeDecisionId,
  id,
}: {
  activeDecisionId?: string | undefined;
  id: string;
}) =>
  ({
    type: "chat",
    id: toChatThreadId(id),
    label: "Chat",
    contextMatterIds: [],
    activeDecisionId,
  }) satisfies InspectorTab;

const matterTab = {
  type: "matter",
  id: "matter:workspace-1",
  label: "Matter",
  workspaceId: "workspace-1",
} satisfies InspectorTab;

describe("the chat tab a decision's conversation is open in", () => {
  test("is none when no tab carries the decision", () => {
    expect(
      decisionChatTabThreadId({
        decisionId: DECISION,
        tabs: [matterTab, chatTab({ id: "thread-1" })],
      }),
    ).toBeUndefined();
  });

  test("ignores a chat tab about another decision", () => {
    expect(
      decisionChatTabThreadId({
        decisionId: DECISION,
        tabs: [chatTab({ activeDecisionId: "decision-9", id: "thread-1" })],
      }),
    ).toBeUndefined();
  });

  test("is the most recent tab when a new chat superseded an older one", () => {
    expect(
      decisionChatTabThreadId({
        decisionId: DECISION,
        tabs: [
          chatTab({ activeDecisionId: DECISION, id: "thread-1" }),
          chatTab({ activeDecisionId: DECISION, id: "thread-2" }),
        ],
      }),
    ).toBe(OTHER_THREAD);
  });
});

describe("the thread the docked inspector is showing", () => {
  test("is none when the active tab is not a chat", () => {
    expect(
      activeChatTabThreadId({
        activeId: matterTab.id,
        tabs: [matterTab, chatTab({ id: "thread-1" })],
      }),
    ).toBeUndefined();
  });

  test("is none when nothing is active", () => {
    expect(
      activeChatTabThreadId({
        activeId: null,
        tabs: [chatTab({ id: "thread-1" })],
      }),
    ).toBeUndefined();
  });

  test("is the active chat tab's own thread", () => {
    expect(
      activeChatTabThreadId({
        activeId: "thread-2",
        tabs: [chatTab({ id: "thread-1" }), chatTab({ id: "thread-2" })],
      }),
    ).toBe(OTHER_THREAD);
  });
});

describe("where the reader's conversation is read", () => {
  test("is the tab when it is on screen showing this very thread", () => {
    expect(
      overlayThreadCardVisibility({
        overlayThreadId: THREAD,
        tabOpen: true,
        tabThreadId: THREAD,
      }),
    ).toBe("tab");
  });

  test("is the floating card while the inspector is minimized", () => {
    expect(
      overlayThreadCardVisibility({
        overlayThreadId: THREAD,
        tabOpen: false,
        tabThreadId: THREAD,
      }),
    ).toBe("card");
  });

  test("is the floating card when the tab on screen is another thread", () => {
    expect(
      overlayThreadCardVisibility({
        overlayThreadId: THREAD,
        tabOpen: true,
        tabThreadId: OTHER_THREAD,
      }),
    ).toBe("card");
  });

  test("is the floating card when no chat tab is on screen", () => {
    expect(
      overlayThreadCardVisibility({
        overlayThreadId: THREAD,
        tabOpen: true,
        tabThreadId: undefined,
      }),
    ).toBe("card");
  });
});
