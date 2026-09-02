import { EventType } from "@tanstack/ai";
import type { StreamChunk, TokenUsage } from "@tanstack/ai";
import { describe, expect, test } from "bun:test";

import { runEvalModelTurn } from "./model-turn";

type TextMessageContentChunk = Extract<
  StreamChunk,
  { type: "TEXT_MESSAGE_CONTENT" }
>;
type RunErrorChunk = Extract<StreamChunk, { type: "RUN_ERROR" }>;
type RunFinishedChunk = Extract<StreamChunk, { type: "RUN_FINISHED" }>;

const textChunk = (delta: string) =>
  ({
    type: EventType.TEXT_MESSAGE_CONTENT,
    messageId: "msg-1",
    delta,
  }) satisfies TextMessageContentChunk;

const runErrorChunk = (message: string) =>
  ({ type: EventType.RUN_ERROR, message }) satisfies RunErrorChunk;

const runFinishedChunk = (usage: TokenUsage) =>
  ({
    type: EventType.RUN_FINISHED,
    runId: "run-1",
    threadId: "thread-1",
    usage,
  }) satisfies RunFinishedChunk;

/**
 * Wraps the real timer functions so a test can assert `clearTimer` ran
 * (proof the `finally` clause fired) without a fake, unsafely-typed
 * `Timeout` handle. `timeoutMs` is generous enough in every test that the
 * abort callback never fires before the turn resolves and clears it.
 */
const fakeTimer = () => {
  const cleared: ReturnType<typeof setTimeout>[] = [];
  return {
    cleared,
    setTimer: (callback: () => void, ms: number) => setTimeout(callback, ms),
    clearTimer: (handle: ReturnType<typeof setTimeout>) => {
      cleared.push(handle);
      clearTimeout(handle);
    },
  };
};

describe("runEvalModelTurn", () => {
  test("a stream that yields partial text then throws: error is set, the partial text was delivered, and the timer was cleared", async () => {
    const timer = fakeTimer();
    let finalText = "";

    async function* partialThenThrow() {
      yield textChunk("Hello ");
      yield textChunk("world");
      throw new Error("stream dropped mid-turn");
    }

    const result = await runEvalModelTurn({
      chat: () => partialThenThrow(),
      timeoutMs: 30_000,
      onChunk: (chunk) => {
        if (chunk.type === EventType.TEXT_MESSAGE_CONTENT) {
          finalText += chunk.delta;
        }
      },
      setTimer: timer.setTimer,
      clearTimer: timer.clearTimer,
    });

    expect(result.error).toBe("stream dropped mid-turn");
    expect(finalText).toBe("Hello world");
    expect(timer.cleared.length).toBe(1);
  });

  test("a stream that completes: error is null and usage is captured", async () => {
    const timer = fakeTimer();
    let finalText = "";
    const usage: TokenUsage = {
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15,
    };

    async function* completes() {
      yield textChunk("Hello");
      yield runFinishedChunk(usage);
    }

    const result = await runEvalModelTurn({
      chat: () => completes(),
      timeoutMs: 30_000,
      onChunk: (chunk) => {
        if (chunk.type === EventType.TEXT_MESSAGE_CONTENT) {
          finalText += chunk.delta;
        }
      },
      setTimer: timer.setTimer,
      clearTimer: timer.clearTimer,
    });

    expect(result.error).toBeNull();
    expect(finalText).toBe("Hello");
    expect(result.usage).toEqual(usage);
    expect(timer.cleared.length).toBe(1);
  });

  test("a RUN_ERROR chunk: error is set from its message", async () => {
    const timer = fakeTimer();

    async function* runErrors() {
      yield runErrorChunk("provider refused the request");
    }

    const result = await runEvalModelTurn({
      chat: () => runErrors(),
      timeoutMs: 30_000,
      onChunk: () => {
        // This eval scores nothing else on this turn.
      },
      setTimer: timer.setTimer,
      clearTimer: timer.clearTimer,
    });

    expect(result.error).toBe("provider refused the request");
    expect(result.usage).toBeNull();
    expect(timer.cleared.length).toBe(1);
  });
});
