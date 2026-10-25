import { EventType } from "@tanstack/ai";
import { ChatClient } from "@tanstack/ai-client";
import type { QueueConfig, RunAgentInputContext } from "@tanstack/ai-client";
import { createChatDevtoolsBridge } from "@tanstack/ai-client/devtools";
import { panic } from "better-result";
import { expect, test } from "bun:test";

import {
  createSseFixture,
  encodeChunks,
  expectPersistedReloadParity,
  finishAnswer,
  LOCAL_TOOL_NAME,
  sseResponse,
  startAnswer,
  toolCall,
} from "./tests/chat-stream-cancellation-fixtures";

test("a real startup callback failure releases only its delivery claim and the next message sends", async () => {
  const failure = new Error("Fixture startup callback failed");
  const errors: Error[] = [];
  let callbackState: "throw-once" | "reported" = "throw-once";
  const { connection, requests } = createSseFixture((run) =>
    sseResponse([
      ...startAnswer(run, "next-answer"),
      {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: "next-answer",
        delta: "NEXT_COMPLETED",
      },
      ...finishAnswer(run, "next-answer"),
    ]),
  );
  const client = new ChatClient({
    threadId: "startup-thread",
    connection,
    onRunIdChange: (id) => {
      if (id !== null && callbackState === "throw-once") {
        callbackState = "reported";
        throw failure;
      }
    },
    onError: (error) => {
      errors.push(error);
    },
  });
  try {
    client.attach();
    await client.sendMessage("first");
    expect(errors).toEqual([failure]);
    expect(errors.at(0)).toBe(failure);
    expect(client.getError()).toBe(failure);
    expect(client.getStatus()).toBe("error");
    expect(requests).toEqual([]);
    await client.sendMessage("next");
    expect(requests).toHaveLength(1);
    expect(client.getQueue()).toEqual([]);
    expect(client.getIsLoading()).toBe(false);
    expect(client.getStatus()).toBe("ready");
    expect(
      JSON.stringify(expectPersistedReloadParity(client.getMessages())),
    ).toContain("NEXT_COMPLETED");
  } finally {
    client.dispose();
  }
});

const QUEUE_DRAIN_CASES = {
  fifo: "fifo",
  batch: "batch",
} as const satisfies Record<
  NonNullable<QueueConfig["drain"]>,
  NonNullable<QueueConfig["drain"]>
>;

for (const drain of Object.values(QUEUE_DRAIN_CASES)) {
  test(`${drain} does not deliver an item removed just before a queue callback stops the turn`, async () => {
    const connected = Promise.withResolvers<RunAgentInputContext>();
    const controller =
      Promise.withResolvers<ReadableStreamDefaultController<Uint8Array>>();
    const errors: Error[] = [];
    let phase: "queueing" | "draining" | "stopped" = "queueing";
    const { connection, requests } = createSseFixture((run, index) => {
      if (index === 1) {
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
      return sseResponse([
        ...startAnswer(run, "after-stop"),
        {
          type: EventType.TEXT_MESSAGE_CONTENT,
          messageId: "after-stop",
          delta: "AFTER_STOP",
        },
        ...finishAnswer(run, "after-stop"),
      ]);
    });
    const client = new ChatClient({
      threadId: "queue-thread",
      connection,
      queue: { drain },
      onQueueChange: () => {
        if (phase !== "draining") {
          return;
        }
        phase = "stopped";
        client.stop();
      },
      onError: (error) => {
        errors.push(error);
      },
    });
    try {
      client.attach();
      const first = client.sendMessage("initial", { marker: "initial" });
      const run = await connected.promise;
      await client.sendMessage("queued one", { marker: "queued-one" });
      await client.sendMessage("queued two", { marker: "queued-two" });
      expect(client.getQueue()).toHaveLength(2);
      phase = "draining";
      const response = await controller.promise;
      response.enqueue(encodeChunks(finishAnswer(run, "initial-answer")));
      response.close();
      await first;
      expect(phase).toBe("stopped");
      expect(requests).toHaveLength(1);
      expect(client.getQueue()).toEqual([]);
      expect(JSON.stringify(client.getMessages())).not.toContain("queued one");
      expect(JSON.stringify(client.getMessages())).not.toContain("queued two");
      await client.sendMessage("after stop", { marker: "after-stop" });
      expect(
        requests.map((request) => request.forwardedProps?.["marker"]),
      ).toEqual(["initial", "after-stop"]);
      expect(client.getQueue()).toEqual([]);
      expect(client.getIsLoading()).toBe(false);
      expect(client.getStatus()).toBe("ready");
      expect(errors).toEqual([]);
      expect(
        JSON.stringify(expectPersistedReloadParity(client.getMessages())),
      ).toContain("AFTER_STOP");
    } finally {
      client.dispose();
    }
  });
}

test("an old approval response cannot answer a replacement pending transcript installed by its snapshot listener", async () => {
  let phase: "capturing" | "replace-next-snapshot" | "replaced" = "capturing";
  const errors: Error[] = [];
  const { connection, requests } = createSseFixture((run) =>
    sseResponse([
      ...startAnswer(run, "original-answer"),
      ...toolCall({ callId: "approval-call", messageId: "original-answer" }),
      { type: EventType.TEXT_MESSAGE_END, messageId: "original-answer" },
      {
        type: EventType.RUN_FINISHED,
        runId: run.runId,
        threadId: run.threadId,
        outcome: {
          type: "interrupt",
          interrupts: [
            {
              id: "approval-id",
              reason: "approval_required",
              toolCallId: "approval-call",
              metadata: {
                kind: "approval",
                toolName: LOCAL_TOOL_NAME,
                input: {},
              },
            },
          ],
        },
      },
    ]),
  );
  let replacePending: (() => void) | undefined;
  const client = new ChatClient({
    threadId: "approval-thread",
    connection,
    devtoolsBridgeFactory: (options) => {
      const bridge = createChatDevtoolsBridge(options);
      const emitSnapshot = bridge.emitSnapshot.bind(bridge);
      bridge.emitSnapshot = () => {
        if (phase === "replace-next-snapshot") {
          phase = "replaced";
          if (replacePending === undefined) {
            return panic("The replacement transcript was not captured");
          }
          replacePending();
        }
        emitSnapshot();
      };
      return bridge;
    },
    onError: (error) => {
      errors.push(error);
    },
  });
  try {
    client.attach();
    await client.sendMessage("first question");
    const replacement = structuredClone(client.getMessages()).map(
      (message) => ({
        ...message,
        id:
          message.role === "assistant"
            ? "replacement-answer"
            : "replacement-question",
      }),
    );
    const produced = replacement
      .flatMap((message) => message.parts)
      .find((part) => part.type === "tool-call" && part.id === "approval-call");
    if (produced?.type !== "tool-call") {
      return panic("The real SDK did not produce its pending approval");
    }
    expect(produced.state).toBe("approval-requested");
    expect(produced.approval?.approved).toBeUndefined();
    replacePending = () => {
      client.stop();
      // setMessagesManually supports stored legacy approvals; no synchronous
      // hydration of a future network response is assumed by this fixture.
      client.setMessagesManually(replacement);
    };
    phase = "replace-next-snapshot";
    await client.addToolApprovalResponse({ id: "approval-id", approved: true });
    expect(phase).toBe("replaced");
    expect(requests).toHaveLength(1);
    const pending = client
      .getMessages()
      .flatMap((message) => message.parts)
      .find((part) => part.type === "tool-call" && part.id === "approval-call");
    if (pending?.type !== "tool-call") {
      return panic("The replacement approval disappeared");
    }
    expect(pending.state).toBe("approval-requested");
    expect(pending.approval?.approved).toBeUndefined();
    expect(pending.output).toBeUndefined();
    expect(errors).toEqual([]);
    expectPersistedReloadParity(client.getMessages());
  } finally {
    client.dispose();
  }
});
