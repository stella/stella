import { describe, expect, test } from "bun:test";

import type { InspectorTab } from "@/components/inspector/inspector-store-types";
import {
  decisionChatKey,
  statuteChatKey,
} from "@/features/chat/legal-document-chat-key";
import type { LegalDocumentChatKey } from "@/features/chat/legal-document-chat-key";
import { toChatThreadId } from "@/lib/chat-thread-ref";

import {
  activeChatTabThreadId,
  legalDocumentChatTabThreadId,
  readerOverlayActivation,
} from "./legal-reader-ai-chat.logic";

const DECISION = decisionChatKey("decision-1");
const STATUTE = statuteChatKey("decision-1");
const THREAD = toChatThreadId("thread-1");
const OTHER_THREAD = toChatThreadId("thread-2");

const chatTab = ({
  activeLegalKey,
  id,
}: {
  activeLegalKey?: LegalDocumentChatKey | undefined;
  id: string;
}) =>
  ({
    type: "chat",
    id: toChatThreadId(id),
    label: "Chat",
    contextMatterIds: [],
    activeLegalKey,
  }) satisfies InspectorTab;

const matterTab = {
  type: "matter",
  id: "matter:workspace-1",
  label: "Matter",
  workspaceId: "workspace-1",
} satisfies InspectorTab;

describe("the chat tab a document's conversation is open in", () => {
  test("is none when no tab carries the document", () => {
    expect(
      legalDocumentChatTabThreadId({
        documentKey: DECISION,
        tabs: [matterTab, chatTab({ id: "thread-1" })],
      }),
    ).toBeUndefined();
  });

  test("ignores a chat tab about another document", () => {
    expect(
      legalDocumentChatTabThreadId({
        documentKey: DECISION,
        tabs: [
          chatTab({ activeLegalKey: decisionChatKey("decision-9"), id: "t" }),
        ],
      }),
    ).toBeUndefined();
  });

  test("ignores a tab about the other corpus under the same id", () => {
    expect(
      legalDocumentChatTabThreadId({
        documentKey: STATUTE,
        tabs: [chatTab({ activeLegalKey: DECISION, id: "thread-1" })],
      }),
    ).toBeUndefined();
  });

  test("is the most recent tab when a new chat superseded an older one", () => {
    expect(
      legalDocumentChatTabThreadId({
        documentKey: STATUTE,
        tabs: [
          chatTab({ activeLegalKey: STATUTE, id: "thread-1" }),
          chatTab({ activeLegalKey: STATUTE, id: "thread-2" }),
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

describe("whether the composer floats over the text", () => {
  test("does not while a tab on screen shows this very thread", () => {
    expect(
      readerOverlayActivation({
        overlayThreadId: THREAD,
        tabOpen: true,
        tabThreadId: THREAD,
      }),
    ).toBe("deferred");
  });

  test("does while the inspector is minimized", () => {
    expect(
      readerOverlayActivation({
        overlayThreadId: THREAD,
        tabOpen: false,
        tabThreadId: THREAD,
      }),
    ).toBe("active");
  });

  test("does when the tab on screen is another thread", () => {
    expect(
      readerOverlayActivation({
        overlayThreadId: THREAD,
        tabOpen: true,
        tabThreadId: OTHER_THREAD,
      }),
    ).toBe("active");
  });

  test("does when no chat tab is on screen", () => {
    expect(
      readerOverlayActivation({
        overlayThreadId: THREAD,
        tabOpen: true,
        tabThreadId: undefined,
      }),
    ).toBe("active");
  });
});
