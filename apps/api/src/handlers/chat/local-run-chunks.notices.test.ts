import { EventType, StreamProcessor } from "@tanstack/ai";
import type { StreamChunk, UIMessage } from "@tanstack/ai";
import { describe, expect, test } from "bun:test";

import { type HarnessEvent, harnessSessionId } from "@stll/agent-engine";
import {
  CHAT_LOCAL_RUN_NOTICES_METADATA_KEY,
  type ChatLocalRunNotice,
  chatLocalRunNoticesOf,
  DESKTOP_RUNNER_NOTICE_EVENT,
} from "@stll/api-contract/chat-local-run-notice";

import {
  chatMessageContentFromMessage,
  chatMessageFromPersisted,
  toPersistableChatMessage,
} from "@/api/handlers/chat/chat-message-parts";
import {
  toChatMessage,
  withLocalRunAnswerMetadata,
} from "@/api/handlers/chat/stream-chat";
import { toSafeId } from "@/api/lib/branded-types";
import { isRecord } from "@/api/lib/type-guards";
import {
  adoptedSource,
  createComputer,
  harnessChunks,
  localSource,
} from "@/api/tests/helpers/fake-local-computer";

const started: HarnessEvent = {
  type: "session.started",
  sessionId: harnessSessionId("session-notices"),
  continuation: { type: "fresh" },
};
const retry = (attempt: number): HarnessEvent => ({
  type: "notice",
  notice: { kind: "retrying", attempt, maxAttempts: 5 },
});

/** A turn that warns about its setup, retries the model, then answers. */
const turnChunks = async () =>
  await harnessChunks([
    started,
    { type: "notice", notice: { kind: "config_warning" } },
    {
      type: "notice",
      notice: { kind: "capability_unavailable", capability: "browser" },
    },
    retry(1),
    retry(2),
    { type: "notice", notice: { kind: "config_warning" } },
    { type: "text.delta", messageId: "answer", delta: "The lease ends " },
    {
      type: "text.completed",
      messageId: "answer",
      text: "The lease ends in March.",
    },
    { type: "turn.completed", usage: null, boundary: null },
  ]);

const readAll = async (source: AsyncIterable<StreamChunk>) => {
  const chunks: StreamChunk[] = [];
  for await (const chunk of source) {
    chunks.push(chunk);
  }
  return chunks;
};

const uninterruptedRead = async (chunks: readonly StreamChunk[]) => {
  const computer = createComputer();
  computer.events(chunks);
  computer.finish();
  return await readAll(localSource(computer)(new AbortController().signal));
};

/** Each restatement of the run's notices a read yields. */
const restatementsOf = (chunks: readonly StreamChunk[]) =>
  chunks.flatMap((chunk) =>
    chunk.type === EventType.TEXT_MESSAGE_START &&
    isRecord(chunk.metadata) &&
    CHAT_LOCAL_RUN_NOTICES_METADATA_KEY in chunk.metadata
      ? [chatLocalRunNoticesOf(chunk.metadata)]
      : [],
  );

/**
 * The answer as a stream processor folds it: what the page shows live. The
 * send names every message of the turn's stream as its one answer
 * (`createChatMessageIdMapper`), so the read's restatements land on it.
 */
const liveAnswer = (chunks: readonly StreamChunk[]): UIMessage => {
  const processor = new StreamProcessor({ initialMessages: [] });
  for (const chunk of chunks) {
    processor.processChunk(
      "messageId" in chunk ? { ...chunk, messageId: "answer" } : chunk,
    );
  }
  const answer = processor.getMessages().at(-1);
  if (answer === undefined) {
    throw new Error("The read folded into no answer");
  }
  return answer;
};

/** The answer stored the way a send stores it, then read back. */
const reloaded = (streamed: UIMessage) => {
  const converted = toChatMessage(streamed);
  if (converted === null) {
    throw new Error("The answer converted to nothing");
  }
  const message = toPersistableChatMessage({
    ...withLocalRunAnswerMetadata(converted, streamed),
    id: toSafeId<"chatMessage">("msg_notices"),
  });
  return chatMessageFromPersisted({
    id: message.id,
    role: "assistant",
    content: chatMessageContentFromMessage(message),
  });
};

const FINAL: readonly ChatLocalRunNotice[] = [
  { kind: "config_warning" },
  { kind: "capability_unavailable", capability: "browser" },
  { kind: "retrying", status: "recovered", attempt: 2, maxAttempts: 5 },
];

describe("what a local run says about itself", () => {
  test("restates one line per condition as it changes, live and after a reload", async () => {
    const read = await uninterruptedRead(await turnChunks());
    // The repeated warning adds nothing; the retry updates its own line.
    expect(restatementsOf(read)).toEqual([
      [{ kind: "config_warning" }],
      [
        { kind: "config_warning" },
        { kind: "capability_unavailable", capability: "browser" },
      ],
      [
        { kind: "config_warning" },
        { kind: "capability_unavailable", capability: "browser" },
        { kind: "retrying", status: "retrying", attempt: 1, maxAttempts: 5 },
      ],
      [
        { kind: "config_warning" },
        { kind: "capability_unavailable", capability: "browser" },
        { kind: "retrying", status: "retrying", attempt: 2, maxAttempts: 5 },
      ],
      FINAL,
    ]);
    // The computer's own event goes no further than the API.
    expect(
      read.some(
        (chunk) =>
          chunk.type === EventType.CUSTOM &&
          chunk.name === DESKTOP_RUNNER_NOTICE_EVENT,
      ),
    ).toBe(false);
    const live = liveAnswer(read);
    expect(chatLocalRunNoticesOf(live.metadata)).toEqual(FINAL);
    expect(chatLocalRunNoticesOf(reloaded(live).metadata)).toEqual(FINAL);
  });

  test("an adopted read ends with the notices an uninterrupted one ends with, from every cut", async () => {
    const chunks = await turnChunks();
    for (let cut = 0; cut <= chunks.length; cut += 1) {
      const computer = createComputer();
      computer.events(chunks);
      computer.finish();
      computer.releaseAt(cut);
      const read = await readAll(
        adoptedSource(computer)(new AbortController().signal),
      );
      const restated = restatementsOf(read);
      // A read that adopts after the last notice restates nothing; one that
      // adopts before it ends on the same list as the whole read, and one
      // that adopts before any event restates every notice itself.
      if (cut === 0) {
        expect(restated).toEqual(
          restatementsOf(await uninterruptedRead(chunks)),
        );
      }
      if (restated.length > 0) {
        expect(restated.at(-1)).toEqual(FINAL);
      }
    }
  });

  test("a retry the computer left under way ends with the run, and a notice that does not read or repeats shows nothing", async () => {
    const [opening] = await harnessChunks([started]);
    if (opening === undefined) {
      throw new Error("No run start");
    }
    const notice = (value: unknown): StreamChunk => ({
      type: EventType.CUSTOM,
      name: DESKTOP_RUNNER_NOTICE_EVENT,
      value,
      timestamp: 0,
    });
    const read = await uninterruptedRead([
      opening,
      notice({
        kind: "retrying",
        status: "retrying",
        attempt: 1,
        maxAttempts: 3,
      }),
      notice({
        kind: "retrying",
        status: "retrying",
        attempt: 1,
        maxAttempts: 3,
      }),
      notice({
        kind: "config_warning",
        summary: "/opt/agent-settings/settings.toml",
      }),
      notice({ kind: "capability_unavailable", capability: "camera" }),
    ]);
    expect(restatementsOf(read)).toEqual([
      [{ kind: "retrying", status: "retrying", attempt: 1, maxAttempts: 3 }],
      [{ kind: "retrying", status: "ended", attempt: 1, maxAttempts: 3 }],
    ]);
    expect(JSON.stringify(read)).not.toContain("agent-settings");
    expect(chatLocalRunNoticesOf(liveAnswer(read).metadata)).toEqual([
      { kind: "retrying", status: "ended", attempt: 1, maxAttempts: 3 },
    ]);
  });

  test("an answer whose stream ended while its run still retried is stored with the retry ended", () => {
    // A stop or a cut ends the read before the run settles its retry.
    const retrying: ChatLocalRunNotice = {
      kind: "retrying",
      status: "retrying",
      attempt: 2,
      maxAttempts: 5,
    };
    const streamed = liveAnswer([
      {
        type: EventType.TEXT_MESSAGE_START,
        messageId: "answer",
        role: "assistant",
        timestamp: 0,
        metadata: {
          [CHAT_LOCAL_RUN_NOTICES_METADATA_KEY]: [
            { kind: "config_warning" },
            retrying,
          ],
        },
      },
      {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: "answer",
        delta: "Reading the lease.",
        timestamp: 0,
      },
    ]);
    expect(chatLocalRunNoticesOf(reloaded(streamed).metadata)).toEqual([
      { kind: "config_warning" },
      { ...retrying, status: "ended" },
    ]);
  });
});
