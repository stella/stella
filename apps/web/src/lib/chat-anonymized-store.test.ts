import { beforeEach, describe, expect, test } from "bun:test";

import { CHAT_SEND_MODE } from "@stll/anonymize-chat";

import {
  getChatSendMode,
  setChatAnonymized,
  useChatAnonymizedStore,
} from "@/lib/chat-anonymized-store";
import { toChatThreadId } from "@/lib/chat-thread-ref";
import type { ChatThreadRef } from "@/lib/chat-thread-ref";

const globalThread = (threadId: string): ChatThreadRef => ({
  scope: "global",
  threadId: toChatThreadId(threadId),
});

beforeEach(() => {
  useChatAnonymizedStore.setState({
    defaultSendMode: CHAT_SEND_MODE.rawOverride,
    sendModes: {},
  });
});

describe("chat anonymization scope", () => {
  test("changing an inspector chat cannot change the main chat", () => {
    const main = globalThread("main-thread");
    const inspector = globalThread("inspector-thread");

    setChatAnonymized(inspector, true);

    expect(getChatSendMode(inspector)).toBe(CHAT_SEND_MODE.anonymized);
    expect(getChatSendMode(main)).toBe(CHAT_SEND_MODE.rawOverride);
  });

  test("the full workspace identity separates otherwise equal thread ids", () => {
    const threadId = toChatThreadId("shared-thread-id");
    const first: ChatThreadRef = {
      scope: "workspace",
      threadId,
      workspaceId: "workspace-one",
    };
    const second: ChatThreadRef = {
      scope: "workspace",
      threadId,
      workspaceId: "workspace-two",
    };

    setChatAnonymized(first, true);

    expect(getChatSendMode(first)).toBe(CHAT_SEND_MODE.anonymized);
    expect(getChatSendMode(second)).toBe(CHAT_SEND_MODE.rawOverride);
  });

  test("never evicts privacy-increasing thread overrides", () => {
    for (let index = 0; index < 101; index += 1) {
      setChatAnonymized(globalThread(`thread-${index}`), true);
    }

    expect(
      Object.keys(useChatAnonymizedStore.getState().sendModes),
    ).toHaveLength(101);
    expect(getChatSendMode(globalThread("thread-0"))).toBe(
      CHAT_SEND_MODE.anonymized,
    );
    expect(getChatSendMode(globalThread("thread-100"))).toBe(
      CHAT_SEND_MODE.anonymized,
    );
  });
});
