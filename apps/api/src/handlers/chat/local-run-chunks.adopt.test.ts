import { EventType, RUN_CANCEL_REASON } from "@tanstack/ai";
import type { StreamChunk } from "@tanstack/ai";
import { describe, expect, test } from "bun:test";

import { harnessSessionId } from "@stll/agent-engine";
import { CHAT_LOCAL_RUN_COMPUTER_EVENT } from "@stll/api-contract/chat-run-target";

import {
  adoptedSource,
  createComputer,
  harnessChunks,
  localSource,
} from "@/api/tests/helpers/fake-local-computer";

const toolCall = {
  id: "item_3",
  name: "command_execution",
  input: { command: "bun test" },
};

/** A harness turn whose call is still open across most cut positions. */
const turnChunks = async () =>
  await harnessChunks([
    {
      type: "session.started",
      sessionId: harnessSessionId("session-adopted"),
      continuation: { type: "fresh" },
    },
    { type: "text.delta", messageId: "answer", delta: "Running the tests. " },
    { type: "tool.started", toolCall },
    {
      type: "tool.completed",
      toolCall,
      result: { content: "12 pass", status: "succeeded" },
    },
    { type: "text.delta", messageId: "answer", delta: "All tests pass." },
    {
      type: "text.completed",
      messageId: "answer",
      text: "Running the tests. All tests pass.",
    },
    { type: "turn.completed", usage: null, boundary: null },
  ]);

/** A chunk without the clock reading it was made at. */
const timeless = (chunk: StreamChunk) => {
  const { timestamp: _timestamp, ...rest } = chunk;
  return rest;
};

const readAll = async (source: AsyncIterable<StreamChunk>) => {
  const chunks: StreamChunk[] = [];
  for await (const chunk of source) {
    chunks.push(chunk);
  }
  return chunks.map(timeless);
};

/** Every chunk the run's whole read yields, read once without a handover. */
const uninterruptedRead = async (chunks: readonly StreamChunk[]) => {
  const computer = createComputer();
  computer.events(chunks);
  computer.finish();
  return await readAll(localSource(computer)(new AbortController().signal));
};

const adoptedRead = async (chunks: readonly StreamChunk[], cut: number) => {
  const computer = createComputer();
  computer.events(chunks);
  computer.finish();
  computer.releaseAt(cut);
  const read = await readAll(
    adoptedSource(computer)(new AbortController().signal),
  );
  return { computer, read };
};

/**
 * What the uninterrupted read yields for the events through `cut`: a read of
 * them, cut short once it caught up and waits for more.
 */
const readThrough = async (chunks: readonly StreamChunk[], cut: number) => {
  const computer = createComputer();
  computer.events(chunks.slice(0, cut));
  const caughtUp = Promise.withResolvers<"caught-up">();
  const { control } = computer.context;
  computer.context.control = {
    ...control,
    // A read asks for the run's state only once no stored event is left.
    readRun: async (options) => {
      caughtUp.resolve("caught-up");
      return await control.readRun(options);
    },
  };
  const stop = new AbortController();
  const reader = localSource(computer)(stop.signal)[Symbol.asyncIterator]();
  const read: StreamChunk[] = [];
  let next = reader.next();
  for (;;) {
    const step = await Promise.race([next, caughtUp.promise]);
    if (step === "caught-up") {
      stop.abort(RUN_CANCEL_REASON);
      break;
    }
    if (step.done === true) {
      return read.map(timeless);
    }
    read.push(step.value);
    next = reader.next();
  }
  for (let step = await next; step.done !== true; step = await reader.next()) {
    read.push(step.value);
  }
  return read.map(timeless);
};

/** Whether a chunk only says where the computer stands. */
const isComputerStatus = (chunk: ReturnType<typeof timeless>) =>
  chunk.type === EventType.CUSTOM &&
  "name" in chunk &&
  chunk.name === CHAT_LOCAL_RUN_COMPUTER_EVENT;

const answerOf = (chunks: ReturnType<typeof timeless>[]) =>
  chunks.filter((chunk) => !isComputerStatus(chunk));

describe("a local turn another task adopted", () => {
  test("reads on as the uninterrupted read would, from every cut", async () => {
    const chunks = await turnChunks();
    const whole = await uninterruptedRead(chunks);
    // Every position a released reader can stop at: before any event, after
    // each one, and with only the run's own end left to read.
    for (let cut = 0; cut <= chunks.length; cut += 1) {
      const before = await readThrough(chunks, cut);
      const { computer, read } = await adoptedRead(chunks, cut);

      // A page rejoining the log sees progress at once.
      expect(read.at(0)).toMatchObject({
        type: EventType.CUSTOM,
        name: CHAT_LOCAL_RUN_COMPUTER_EVENT,
        value: { status: "connected" },
      });
      // What the released read yielded, then what the adopted one yields,
      // is what one read yields: nothing missing, nothing twice, and no
      // second run start.
      expect([...answerOf(before), ...answerOf(read)]).toEqual(answerOf(whole));
      expect(computer.queued.interrupts).toBe(0);
    }
  });

  test("a result after the cut belongs to the call opened before it", async () => {
    const chunks = await turnChunks();
    const opened = chunks.findIndex(
      (chunk) => chunk.type === EventType.TOOL_CALL_START,
    );
    expect(opened).toBeGreaterThan(-1);
    const { read } = await adoptedRead(chunks, opened + 1);

    expect(
      read.some(
        (chunk) =>
          chunk.type === EventType.TOOL_CALL_RESULT &&
          chunk.toolCallId.endsWith(toolCall.id),
      ),
    ).toBe(true);
  });
});
