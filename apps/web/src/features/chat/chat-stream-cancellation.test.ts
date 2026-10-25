import { EventType } from "@tanstack/ai";
import type { StreamChunk } from "@tanstack/ai";
import { ChatClient } from "@tanstack/ai-client";
import type {
  ChatPersistedState,
  RunAgentInputContext,
} from "@tanstack/ai-client";
import { panic } from "better-result";
import { expect, test } from "bun:test";

import {
  createSseFixture,
  encodeChunks,
  expectPersistedReloadParity,
  finishAnswer,
  LOCAL_TOOL_NAME,
  pauseSdkSubscriber,
  sseResponse,
  startAnswer,
  toolCall,
} from "./tests/chat-stream-cancellation-fixtures";

for (const { mode } of [{ mode: "reload" }, { mode: "send" }] as const) {
  for (const terminal of [
    EventType.RUN_FINISHED,
    EventType.RUN_ERROR,
  ] as const) {
    test(`${mode} excludes stopped reasoning, text, result and ${terminal} while preserving a fresh approval child`, async () => {
      const scheduler = pauseSdkSubscriber();
      let dispose: (() => void) | undefined;
      try {
        const connected = Promise.withResolvers<RunAgentInputContext>();
        const prefix = Promise.withResolvers<undefined>();
        const childConnected = Promise.withResolvers<undefined>();
        const childSettled = Promise.withResolvers<undefined>();
        const response =
          Promise.withResolvers<ReadableStreamDefaultController<Uint8Array>>();
        const errors: Error[] = [];
        const stale: StreamChunk[] = [];
        let requestState: "original" | "stopped" = "original";
        const { connection, requests } = createSseFixture((run, index) => {
          if (index === 1) {
            return sseResponse([
              ...startAnswer(run, "old-answer"),
              ...toolCall({ callId: "first-call", messageId: "old-answer" }),
              ...toolCall({ callId: "old-call", messageId: "old-answer" }),
              {
                type: EventType.TOOL_CALL_RESULT,
                toolCallId: "first-call",
                messageId: "first-result",
                content: "{}",
              },
              {
                type: EventType.REASONING_MESSAGE_CONTENT,
                messageId: "old-reasoning",
                delta: "OLD_REASONING",
              },
              {
                type: EventType.TEXT_MESSAGE_CONTENT,
                messageId: "old-answer",
                delta: "OLD_TEXT",
              },
              {
                type: EventType.TOOL_CALL_RESULT,
                toolCallId: "old-call",
                messageId: "old-result",
                content: '{"value":"OLD_RESULT"}',
              },
              terminal === EventType.RUN_ERROR
                ? {
                    type: EventType.RUN_ERROR,
                    runId: run.runId,
                    threadId: run.threadId,
                    message: "OLD_ERROR",
                  }
                : {
                    type: EventType.RUN_FINISHED,
                    runId: run.runId,
                    threadId: run.threadId,
                  },
            ]);
          }
          if (index === 2) {
            connected.resolve(run);
            return new Response(
              new ReadableStream<Uint8Array>({
                start: (controller) => {
                  response.resolve(controller);
                  controller.enqueue(
                    encodeChunks([
                      ...startAnswer(run, "replacement-answer"),
                      {
                        type: EventType.TEXT_MESSAGE_CONTENT,
                        messageId: "replacement-answer",
                        delta: "NEW_TEXT",
                      },
                    ]),
                  );
                },
              }),
              { headers: { "Content-Type": "text/event-stream" } },
            );
          }
          childConnected.resolve(undefined);
          return sseResponse([
            ...startAnswer(run, "replacement-answer"),
            {
              type: EventType.TOOL_CALL_RESULT,
              toolCallId: "approval-call",
              messageId: "approved-result",
              content: '{"value":"NEW_APPROVED"}',
            },
            {
              type: EventType.TEXT_MESSAGE_CONTENT,
              messageId: "replacement-answer",
              delta: " APPROVAL_COMPLETE",
            },
            ...finishAnswer(run, "replacement-answer"),
          ]);
        });
        const client = new ChatClient({
          threadId: "same-thread",
          connection,
          onChunk: (chunk) => {
            if (
              chunk.type === EventType.TOOL_CALL_RESULT &&
              chunk.toolCallId === "first-call"
            ) {
              scheduler.consumeBudget();
            }
            const original = requests.at(0);
            if (original === undefined) {
              return panic("A chunk arrived before its request");
            }
            if (
              requestState === "stopped" &&
              (("messageId" in chunk && chunk.messageId.startsWith("old-")) ||
                ("toolCallId" in chunk && chunk.toolCallId === "old-call") ||
                ("runId" in chunk && chunk.runId === original.runId))
            ) {
              stale.push(chunk);
            }
          },
          onMessagesChange: (messages) => {
            if (
              messages.some(
                (message) =>
                  message.id === "replacement-answer" &&
                  message.parts.some(
                    (part) =>
                      part.type === "text" && part.content.includes("NEW_TEXT"),
                  ),
              )
            ) {
              prefix.resolve(undefined);
            }
          },
          onLoadingChange: (loading) => {
            if (!loading && requests.length === 3) {
              childSettled.resolve(undefined);
            }
          },
          onError: (error) => {
            errors.push(error);
          },
        });
        dispose = () => client.dispose();
        client.attach();
        const first = client.sendMessage("first question");
        await scheduler.paused;
        requestState = "stopped";
        client.stop();
        await first;
        const replacement =
          mode === "reload"
            ? client.reload()
            : client.sendMessage("replacement question");
        const run = await connected.promise;
        scheduler.release();
        await prefix.promise;
        expect(stale).toEqual([]);
        expect(client.getIsLoading()).toBe(true);
        expect(client.getStatus()).toBe("streaming");
        expect(
          JSON.stringify(expectPersistedReloadParity(client.getMessages())),
        ).not.toContain("OLD_");
        const controller = await response.promise;
        controller.enqueue(
          encodeChunks([
            ...toolCall({
              callId: "approval-call",
              messageId: "replacement-answer",
            }),
            {
              type: EventType.TEXT_MESSAGE_END,
              messageId: "replacement-answer",
            },
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
        controller.close();
        await replacement;
        const approval = client.addToolApprovalResponse({
          id: "approval-id",
          approved: true,
        });
        await childConnected.promise;
        await childSettled.promise;
        await approval;
        expect(requests).toHaveLength(3);
        const parent = requests.at(1);
        const child = requests.at(2);
        expect(child?.parentRunId).toBe(parent?.runId);
        expect(child?.resume).toHaveLength(1);
        expect(
          requests.every((request) => request.threadId === "same-thread"),
        ).toBe(true);
        expect(new Set(requests.map((request) => request.runId)).size).toBe(3);
        expect(client.getIsLoading()).toBe(false);
        expect(client.getStatus()).toBe("ready");
        expect(errors).toEqual([]);
        const shown = JSON.stringify(
          expectPersistedReloadParity(client.getMessages()),
        );
        expect(shown).toContain("NEW_APPROVED");
        expect(shown).not.toContain("OLD_");
      } finally {
        scheduler.release();
        try {
          dispose?.();
        } finally {
          scheduler.restore();
        }
      }
    });
  }
}

const CALLBACK_CASES = [
  { phase: "run-id" },
  { phase: "loading-true" },
  { phase: "response" },
  { phase: "chunk" },
  { phase: "ready" },
  { phase: "loading-false" },
  { phase: "session-true" },
  { phase: "session-false" },
  { phase: "subscription" },
  { phase: "connection" },
  { phase: "error-change" },
  { phase: "error-report" },
  { phase: "finish" },
  { phase: "messages" },
] as const;

type CallbackTurn = "original" | "replacement";

for (const { phase } of CALLBACK_CASES) {
  test(`a ${phase} callback can replace the request without losing its new queue`, async () => {
    const replacement = Promise.withResolvers<undefined>();
    const errors: Error[] = [];
    const runIds: (string | null)[] = [];
    let state: CallbackTurn = "original";
    const writes: { phase: CallbackTurn; state: ChatPersistedState }[] = [];
    const { connection, requests } = createSseFixture((run) => {
      const marker = run.forwardedProps?.["marker"];
      if (typeof marker !== "string") {
        return panic("The fixture request lost its marker");
      }
      const id = `${marker}-answer`;
      return sseResponse([
        ...startAnswer(run, id),
        {
          type: EventType.TEXT_MESSAGE_CONTENT,
          messageId: id,
          delta: marker === "original" ? "OLD_TEXT" : marker.toUpperCase(),
        },
        ...(marker === "original" &&
        (phase === "error-change" || phase === "error-report")
          ? [
              {
                type: EventType.RUN_ERROR,
                runId: run.runId,
                threadId: run.threadId,
                message: "OLD_ERROR",
              } satisfies StreamChunk,
            ]
          : finishAnswer(run, id)),
      ]);
    });
    const replace = () => {
      if (state !== "original") {
        return;
      }
      state = "replacement";
      client.stop();
      const sent = client.sendMessage(
        "replacement",
        { marker: "fresh" },
        { whenBusy: "interrupt" },
      );
      const queued = client.sendMessage("queued fresh", { marker: "queued" });
      Promise.all([sent, queued])
        .then(() => replacement.resolve(undefined))
        .catch(replacement.reject);
    };
    const client = new ChatClient({
      threadId: "callback-thread",
      connection: {
        ...connection,
        joinRun: () => panic("A fresh stored transcript must not rejoin"),
      },
      persistence: {
        getItem: () => ({ messages: [] }),
        setItem: (_id, value) => {
          writes.push({ phase: state, state: structuredClone(value) });
        },
        removeItem: () => undefined,
      },
      onRunIdChange: (id) => {
        runIds.push(id);
        if (phase === "run-id" && id !== null) {
          replace();
        }
      },
      onLoadingChange: (loading) => {
        if (
          (phase === "loading-true" && loading) ||
          (phase === "loading-false" && !loading)
        ) {
          replace();
        }
      },
      onResponse: () => {
        if (phase === "response") {
          replace();
        }
      },
      onChunk: (chunk) => {
        if (
          phase === "chunk" &&
          chunk.type === EventType.TEXT_MESSAGE_CONTENT &&
          chunk.messageId === "original-answer"
        ) {
          replace();
        }
      },
      onStatusChange: (status) => {
        if (phase === "ready" && status === "ready") {
          replace();
        }
      },
      onSessionGeneratingChange: (generating) => {
        if (
          (phase === "session-true" && generating) ||
          (phase === "session-false" && !generating)
        ) {
          replace();
        }
      },
      onSubscriptionChange: (subscribed) => {
        if (phase === "subscription" && subscribed) {
          replace();
        }
      },
      onConnectionStatusChange: (status) => {
        if (phase === "connection" && status === "connecting") {
          replace();
        }
      },
      onErrorChange: (error) => {
        if (phase === "error-change" && error !== undefined) {
          replace();
        }
      },
      onFinish: () => {
        if (phase === "finish") {
          replace();
        }
      },
      onMessagesChange: (messages) => {
        if (
          phase === "messages" &&
          messages.some((message) => message.id === "original-answer")
        ) {
          replace();
        }
      },
      onError: (error) => {
        errors.push(error);
        if (phase === "error-report") {
          replace();
        }
      },
    });
    // Sending also starts the subscriber. These two cases must reach startup's
    // callbacks inside ensureSubscription rather than the earlier attach call.
    try {
      if (phase !== "subscription" && phase !== "connection") {
        client.attach();
      }
      await client.sendMessage("first", { marker: "original" });
      await replacement.promise;
      expect(
        requests.map((request) => request.forwardedProps?.["marker"]),
      ).toEqual(expect.arrayContaining(["fresh", "queued"]));
      expect(client.getQueue()).toEqual([]);
      const shown = JSON.stringify(
        expectPersistedReloadParity(client.getMessages()),
      );
      expect(shown).toContain("FRESH");
      expect(shown).toContain("QUEUED");
      if (phase === "chunk" || phase === "messages") {
        expect(shown).not.toContain("OLD_TEXT");
      }
      expect(client.getIsLoading()).toBe(false);
      expect(client.getStatus()).toBe("ready");
      expect(runIds.at(-1)).toBeNull();
      if (phase === "error-report") {
        expect(errors.map((error) => error.message)).toEqual(["OLD_ERROR"]);
      } else {
        expect(errors).toEqual([]);
      }
      if (phase === "session-true" || phase === "session-false") {
        const original = requests.at(0);
        if (original === undefined) {
          return panic("The session callback never saw its original request");
        }
        expect(
          writes
            .filter((write) => write.phase === "replacement")
            .map((write) => write.state.resume?.resumeState.runId),
        ).not.toContain(original.runId);
        const stored = writes.at(-1)?.state;
        expect(stored).toBeDefined();
        expect(stored?.resume).toBeUndefined();
        const reloaded = new ChatClient({
          threadId: "callback-thread",
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
      }
    } finally {
      client.dispose();
    }
  });
}
