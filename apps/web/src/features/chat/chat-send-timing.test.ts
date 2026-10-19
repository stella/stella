import { expect, mock, test } from "bun:test";

import type { PersistedChatMessage } from "@/components/chat/chat-ui-tools";
import { createChatSendTiming } from "@/features/chat/chat-send-timing";
import type { KeyActionTiming } from "@/lib/analytics/types";

const setup = () => {
  const captured: KeyActionTiming[] = [];
  let time = 0;
  const analytics = {
    captureKeyActionTiming: mock((timing: KeyActionTiming) => {
      captured.push(timing);
    }),
  };
  const timing = createChatSendTiming(
    () => analytics,
    () => time,
  );
  return {
    advance: (ms: number) => {
      time += ms;
    },
    captured,
    timing,
  };
};

const message = (
  id: string,
  role: "assistant" | "user",
  text: string,
): PersistedChatMessage => ({
  id,
  role,
  parts: [{ type: "text", content: text }],
});

const sent = message("user_secret_1", "user", "private question");

test("times the first reply text and the settled request of a sent message", () => {
  const { advance, captured, timing } = setup();

  timing.started("document-chat", sent.id);
  timing.statusChanged("submitted");
  advance(600);
  timing.statusChanged("streaming");
  // An empty text part is not a token yet.
  timing.messagesChanged([sent, message("reply_1", "assistant", " ")]);
  advance(300);
  timing.messagesChanged([sent, message("reply_1", "assistant", "An answer")]);
  advance(4000);
  timing.messagesChanged([
    sent,
    message("reply_1", "assistant", "An answer, longer"),
  ]);
  timing.statusChanged("ready");
  timing.statusChanged("ready");

  expect(captured).toEqual([
    {
      action: "chat-first-token",
      durationBucketMs: 1000,
      surface: "document-chat",
    },
    { action: "chat-total", durationBucketMs: 5000, surface: "document-chat" },
  ]);
  // Exactly these fields: no thread, message or prompt identifies the turn.
  expect(captured.map((entry) => Object.keys(entry).toSorted())).toEqual([
    ["action", "durationBucketMs", "surface"],
    ["action", "durationBucketMs", "surface"],
  ]);
  const payload = JSON.stringify(captured);
  expect(payload).not.toContain("user_secret_1");
  expect(payload).not.toContain("private question");
});

test("assistant text from an earlier turn is not this message's first token", () => {
  const { captured, timing } = setup();
  const earlier = message("reply_0", "assistant", "Earlier answer");

  timing.started("chat-thread", sent.id);
  timing.messagesChanged([earlier, sent]);
  timing.statusChanged("ready");

  expect(captured.map((entry) => entry.action)).toEqual(["chat-total"]);
});

test("reply text before an error or a stop reports nothing", () => {
  const { advance, captured, timing } = setup();

  timing.started("chat-thread", sent.id);
  advance(400);
  timing.messagesChanged([sent, message("reply_1", "assistant", "partial")]);
  timing.statusChanged("error");
  timing.statusChanged("ready");

  timing.started("document-chat", sent.id);
  advance(400);
  timing.messagesChanged([sent, message("reply_2", "assistant", "partial")]);
  timing.abandoned();
  timing.statusChanged("ready");

  expect(captured).toEqual([]);
});

test("an errored, stopped or left turn reports nothing", () => {
  const { captured, timing } = setup();

  timing.started("chat-thread", sent.id);
  timing.statusChanged("error");
  timing.statusChanged("ready");

  timing.started("inspector-chat", sent.id);
  timing.abandoned();
  timing.messagesChanged([sent, message("reply_1", "assistant", "late")]);
  timing.statusChanged("ready");

  expect(captured).toEqual([]);
});

test("a new send replaces the timing of the previous one", () => {
  const { advance, captured, timing } = setup();
  const second = message("user_2", "user", "second");

  timing.started("chat-thread", sent.id);
  advance(10_000);
  timing.started("chat-thread", second.id);
  advance(50);
  timing.statusChanged("ready");

  expect(captured).toEqual([
    { action: "chat-total", durationBucketMs: 100, surface: "chat-thread" },
  ]);
});

test("a send without a surface is not timed", () => {
  const { captured, timing } = setup();

  timing.started(undefined, sent.id);
  timing.messagesChanged([sent, message("reply_1", "assistant", "answer")]);
  timing.statusChanged("ready");

  expect(captured).toEqual([]);
});
