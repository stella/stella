import { EventType, toolDefinition } from "@tanstack/ai";
import type { StreamChunk } from "@tanstack/ai";
import { ChatClient } from "@tanstack/ai-client";
import type { RunAgentInputContext } from "@tanstack/ai-client";
import { panic } from "better-result";
import { expect, test } from "bun:test";
import * as v from "valibot";

import { nextMacrotask } from "@stll/concurrency/event-loop";

import {
  createSseFixture,
  encodeChunks,
  expectPersistedReloadParity,
  finishAnswer,
  LOCAL_TOOL_NAME,
  pendingClientTool,
  sseResponse,
  startAnswer,
  toolCall,
} from "./tests/chat-stream-cancellation-fixtures";

const inputSchema = v.object({});
const outputSchema = v.object({ value: v.string() });

for (const { mode } of [{ mode: "fifo" }, { mode: "public-resume" }] as const) {
  test(`${mode} keeps completed success after a legitimate client-tool child`, async () => {
    const connected = Promise.withResolvers<RunAgentInputContext>();
    const controller =
      Promise.withResolvers<ReadableStreamDefaultController<Uint8Array>>();
    const errors: Error[] = [];
    const tool = toolDefinition({
      name: LOCAL_TOOL_NAME,
      description: "Return the controlled local fixture",
      inputSchema,
      outputSchema,
    }).client(() => Promise.resolve({ value: "TOOL_COMPLETE" }));
    const { connection, requests } = createSseFixture((run, index) => {
      if (mode === "fifo" && index === 1) {
        return new Response(
          new ReadableStream<Uint8Array>({
            start: (response) => {
              controller.resolve(response);
              response.enqueue(
                encodeChunks([
                  ...startAnswer(run, "initial-answer"),
                  {
                    type: EventType.TEXT_MESSAGE_CONTENT,
                    messageId: "initial-answer",
                    delta: "INITIAL",
                  },
                ]),
              );
              connected.resolve(run);
            },
          }),
          { headers: { "Content-Type": "text/event-stream" } },
        );
      }
      const parent = index === (mode === "fifo" ? 2 : 1);
      const id = parent ? "tool-answer" : `answer-${String(index)}`;
      return sseResponse(
        parent
          ? [
              ...startAnswer(run, id),
              ...toolCall({ callId: "lookup-call", messageId: id }),
              { type: EventType.TEXT_MESSAGE_END, messageId: id },
              pendingClientTool(run, "lookup-call"),
            ]
          : [
              ...startAnswer(run, id),
              {
                type: EventType.TEXT_MESSAGE_CONTENT,
                messageId: id,
                delta: `SUCCESS_${String(index)}`,
              },
              ...finishAnswer(run, id),
            ],
      );
    });
    const client = new ChatClient({
      threadId: "continuation-thread",
      connection,
      tools: [tool],
      onError: (error) => {
        errors.push(error);
      },
    });
    try {
      client.attach();
      if (mode === "fifo") {
        const first = client.sendMessage("initial", { marker: "initial" });
        const run = await connected.promise;
        await client.sendMessage("queued tool", { marker: "queued-tool" });
        await client.sendMessage("queued tail", { marker: "queued-tail" });
        const response = await controller.promise;
        response.enqueue(encodeChunks(finishAnswer(run, "initial-answer")));
        response.close();
        await first;
        expect(requests).toHaveLength(4);
        expect(requests.at(3)?.forwardedProps?.["marker"]).toBe("queued-tail");
        expect(client.getQueue()).toEqual([]);
      } else {
        const succeeded = await client.resumeInterruptsUnsafe(
          [{ id: "parked-approval", payload: { approved: true } }],
          { threadId: "continuation-thread", runId: "parked-parent" },
        );
        expect(succeeded).toBe(true);
        expect(requests).toHaveLength(2);
        expect(requests.at(0)?.parentRunId).toBe("parked-parent");
      }
      expect(client.getIsLoading()).toBe(false);
      expect(client.getStatus()).toBe("ready");
      expect(client.getResumeState()).toBeNull();
      expect(errors).toEqual([]);
      expect(
        JSON.stringify(expectPersistedReloadParity(client.getMessages())),
      ).toContain("TOOL_COMPLETE");
    } finally {
      client.dispose();
    }
  });
}

test("a stopped tool finishing cannot remove the pending replacement tool with the same id", async () => {
  const oldStarted = Promise.withResolvers<undefined>();
  const newStarted = Promise.withResolvers<undefined>();
  const oldResult = Promise.withResolvers<{ value: string }>();
  const newResult = Promise.withResolvers<{ value: string }>();
  const sendReturned = Promise.withResolvers<undefined>();
  const controller =
    Promise.withResolvers<ReadableStreamDefaultController<StreamChunk>>();
  const incoming = new ReadableStream<StreamChunk>({
    start: (response) => {
      controller.resolve(response);
    },
  });
  const requests: RunAgentInputContext[] = [];
  const errors: Error[] = [];
  let executions = 0;
  const tool = toolDefinition({
    name: LOCAL_TOOL_NAME,
    description: "Return the controlled local fixture",
    inputSchema,
    outputSchema,
  }).client(async () => {
    executions += 1;
    if (executions === 1) {
      oldStarted.resolve(undefined);
      return await oldResult.promise;
    }
    newStarted.resolve(undefined);
    return await newResult.promise;
  });
  const previousNow = Object.getOwnPropertyDescriptor(performance, "now");
  let dispose: (() => void) | undefined;
  try {
    // This case tests promise ownership; keep the independent SDK time slice idle.
    Object.defineProperty(performance, "now", {
      configurable: true,
      value: () => 0,
    });
    const client = new ChatClient({
      threadId: "identity-thread",
      tools: [tool],
      connection: {
        async *subscribe(signal) {
          const response = await controller.promise;
          signal?.addEventListener(
            "abort",
            () => {
              response.close();
            },
            { once: true },
          );
          for await (const chunk of incoming) {
            if (signal?.aborted) {
              return;
            }
            yield chunk;
          }
        },
        async send(_messages, _data, _signal, run) {
          if (run === undefined) {
            return panic("The SDK omitted its run context");
          }
          requests.push(run);
          const index = requests.length;
          const id = `answer-${String(index)}`;
          const chunks =
            index <= 2
              ? ([
                  ...startAnswer(run, id),
                  ...toolCall({ callId: "reused-call", messageId: id }),
                  { type: EventType.TEXT_MESSAGE_END, messageId: id },
                  pendingClientTool(run, "reused-call"),
                ] satisfies StreamChunk[])
              : ([
                  ...startAnswer(run, id),
                  {
                    type: EventType.TEXT_MESSAGE_CONTENT,
                    messageId: id,
                    delta: "COMPLETE",
                  },
                  ...finishAnswer(run, id),
                ] satisfies StreamChunk[]);
          const response = await controller.promise;
          for (const chunk of chunks) {
            response.enqueue(chunk);
          }
          if (index === 2) {
            await sendReturned.promise;
          }
        },
      },
      onError: (error) => {
        errors.push(error);
      },
    });
    dispose = () => client.dispose();
    client.attach();
    const first = client.sendMessage("first");
    await oldStarted.promise;
    await nextMacrotask();
    client.stop();
    let replacementState: "pending" | "settled" = "pending";
    const second = client.sendMessage("replacement").then(() => {
      replacementState = "settled";
      return undefined;
    });
    await newStarted.promise;
    await nextMacrotask();
    oldResult.resolve({ value: "OLD_RESULT" });
    await first;
    sendReturned.resolve(undefined);
    await nextMacrotask();
    expect(replacementState).toBe("pending");
    expect(client.getIsLoading()).toBe(true);
    newResult.resolve({ value: "NEW_RESULT" });
    await second;
    expect(client.getIsLoading()).toBe(false);
    expect(client.getStatus()).toBe("ready");
    expect(requests).toHaveLength(3);
    expect(executions).toBe(2);
    expect(errors).toEqual([]);
    const shown = JSON.stringify(
      expectPersistedReloadParity(client.getMessages()),
    );
    expect(shown).not.toContain("OLD_RESULT");
    expect(shown).toContain("NEW_RESULT");
  } finally {
    oldResult.resolve({ value: "OLD_RESULT" });
    newResult.resolve({ value: "NEW_RESULT" });
    sendReturned.resolve(undefined);
    try {
      dispose?.();
    } finally {
      if (previousNow === undefined) {
        Reflect.deleteProperty(performance, "now");
      } else {
        Object.defineProperty(performance, "now", previousNow);
      }
    }
  }
});
