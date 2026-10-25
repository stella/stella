import { EventType } from "@tanstack/ai";
import type { StreamChunk } from "@tanstack/ai";
import { ChatClient } from "@tanstack/ai-client";
import type { ChatPersistedState } from "@tanstack/ai-client";
import { panic } from "better-result";
import { expect, jest, test } from "bun:test";

import { nextMacrotask } from "@stll/concurrency/event-loop";

import {
  createSseFixture,
  expectPersistedReloadParity,
  finishAnswer,
  sseResponse,
  startAnswer,
} from "./tests/chat-stream-cancellation-fixtures";

const captureStoredRun = async () => {
  const { connection, requests } = createSseFixture((run) =>
    sseResponse([
      ...startAnswer(run, "stored-answer"),
      {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: "stored-answer",
        delta: "STORED_CONTENT",
      },
      ...finishAnswer(run, "stored-answer"),
    ]),
  );
  const client = new ChatClient({ threadId: "stored-thread", connection });
  try {
    await client.sendMessage("stored question");
    const run = requests.at(0);
    if (run === undefined) {
      return panic("The SDK did not send its stored run");
    }
    return {
      messages: structuredClone(client.getMessages()),
      resume: { resumeState: { threadId: run.threadId, runId: run.runId } },
    } satisfies ChatPersistedState;
  } finally {
    client.dispose();
  }
};

test("replacing async store hydration cannot restore its stopped run in memory or durable storage", async () => {
  const original = await captureStoredRun();
  const loaded = Promise.withResolvers<ChatPersistedState>();
  const replaced = Promise.withResolvers<undefined>();
  const errors: Error[] = [];
  const writes: ChatPersistedState[] = [];
  const { connection, requests } = createSseFixture((run) =>
    sseResponse([
      ...startAnswer(run, "fresh-answer"),
      {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: "fresh-answer",
        delta: "FRESH_CONTENT",
      },
      ...finishAnswer(run, "fresh-answer"),
    ]),
  );
  let phase: "hydrating" | "replaced" = "hydrating";
  const client = new ChatClient({
    threadId: "stored-thread",
    connection: {
      ...connection,
      joinRun: () => panic("Cancelled async hydration must not rejoin"),
    },
    persistence: {
      getItem: () => loaded.promise,
      setItem: (_id, state) => {
        writes.push(structuredClone(state));
      },
      removeItem: () => undefined,
    },
    onMessagesChange: (messages) => {
      if (
        phase !== "hydrating" ||
        !messages.some((message) => message.id === "stored-answer")
      ) {
        return;
      }
      phase = "replaced";
      client.stop();
      client
        .sendMessage("fresh question")
        .then(() => replaced.resolve(undefined))
        .catch(replaced.reject);
    },
    onError: (error) => {
      errors.push(error);
    },
  });
  try {
    client.attach();
    loaded.resolve(original);
    await replaced.promise;
    expect(requests).toHaveLength(1);
    expect(client.getResumeState()).toBeNull();
    expect(client.getStatus()).toBe("ready");
    expect(errors).toEqual([]);
    const stored = writes.at(-1);
    if (stored === undefined) {
      return panic("The replacement was not persisted");
    }
    expect(stored.resume).toBeUndefined();
    expect(JSON.stringify(stored)).toContain("FRESH_CONTENT");
    const reloaded = new ChatClient({
      threadId: "stored-thread",
      connection,
      persistence: {
        getItem: () => stored,
        setItem: () => undefined,
        removeItem: () => undefined,
      },
    });
    try {
      expect(reloaded.getResumeState()).toBeNull();
      expect(expectPersistedReloadParity(reloaded.getMessages())).toEqual(
        expectPersistedReloadParity(client.getMessages()),
      );
    } finally {
      reloaded.dispose();
    }
  } finally {
    client.dispose();
  }
});

for (const { next } of [{ next: "idle" }, { next: "queued-append" }] as const) {
  test(`a soft rejoin deadline keeps its resume pointer and settles ${next}`, async () => {
    const original = await captureStoredRun();
    const joining = Promise.withResolvers<undefined>();
    const settled = Promise.withResolvers<undefined>();
    const appended = Promise.withResolvers<undefined>();
    const resumesAtResponse: ReturnType<ChatClient["getResumeState"]>[] = [];
    const errors: Error[] = [];
    const { connection, requests } = createSseFixture((run) =>
      sseResponse([
        ...startAnswer(run, "after-deadline"),
        {
          type: EventType.TEXT_MESSAGE_CONTENT,
          messageId: "after-deadline",
          delta: "AFTER_DEADLINE",
        },
        ...finishAnswer(run, "after-deadline"),
      ]),
    );
    const client = new ChatClient({
      threadId: "stored-thread",
      connection: {
        ...connection,
        joinRun: (_runId, signal) => {
          if (signal === undefined) {
            return panic("The SDK omitted its rejoin cancellation signal");
          }
          return new ReadableStream<StreamChunk>({
            start: (stream) => {
              signal.addEventListener("abort", () => stream.close(), {
                once: true,
              });
              joining.resolve(undefined);
            },
          });
        },
      },
      persistence: {
        getItem: () => original,
        setItem: () => undefined,
        removeItem: () => undefined,
      },
      onLoadingChange: (loading) => {
        if (!loading) {
          settled.resolve(undefined);
        }
      },
      onResponse: () => {
        resumesAtResponse.push(client.getResumeState());
      },
      onFinish: (message) => {
        if (message.id === "after-deadline") {
          appended.resolve(undefined);
        }
      },
      onError: (error) => {
        errors.push(error);
      },
    });
    try {
      jest.useFakeTimers();
      client.attach();
      await joining.promise;
      expect(client.getStatus()).toBe("streaming");
      expect(client.getIsLoading()).toBe(true);
      if (next === "queued-append") {
        await client.append({ role: "user", content: "queued after rejoin" });
      }
      // Advance the SDK-owned deadline without copying its duration.
      jest.advanceTimersToNextTimer();
      jest.useRealTimers();
      await settled.promise;
      if (next === "queued-append") {
        await appended.promise;
        await nextMacrotask();
        expect(requests).toHaveLength(1);
        expect(resumesAtResponse).toEqual([original.resume.resumeState]);
        expect(
          JSON.stringify(expectPersistedReloadParity(client.getMessages())),
        ).toContain("AFTER_DEADLINE");
      } else {
        await nextMacrotask();
        expect(requests).toEqual([]);
        expect(client.getResumeState()).toEqual(original.resume.resumeState);
      }
      expect(client.getIsLoading()).toBe(false);
      expect(client.getStatus()).toBe("ready");
      expect(errors).toEqual([]);
    } finally {
      try {
        client.dispose();
      } finally {
        jest.useRealTimers();
      }
    }
  });
}
