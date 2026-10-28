import type {
  AbortInfo,
  ChatMiddlewareContext,
  ErrorInfo,
  FinishInfo,
} from "@tanstack/ai";
import { chat, EventType } from "@tanstack/ai";
import { expect, test } from "bun:test";

import {
  createTanStackTerminalHooks,
  tanStackStreamEventLifecycle,
} from "@/api/handlers/chat/tanstack-chat-lifecycle";
import { createScriptedTextAdapter } from "@/api/tests/helpers/chat-round-trip";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

test("TanStack terminal hook canary rejects a second terminal signal", async () => {
  const terminalEvents: string[] = [];
  const hooks = createTanStackTerminalHooks(({ type }) => {
    terminalEvents.push(type);
  });
  const context = asTestRaw<ChatMiddlewareContext>({});

  await hooks.onFinish(context, asTestRaw<FinishInfo>({}));
  const secondTerminal = hooks.onError(context, asTestRaw<ErrorInfo>({}));
  if (!(secondTerminal instanceof Promise)) {
    throw new Error(
      "Expected TanStack terminal hook adapter to be asynchronous",
    );
  }
  const secondTerminalError = await secondTerminal.then(
    () => null,
    (error: unknown) => error,
  );
  expect(String(secondTerminalError)).toContain(
    "TanStack emitted more than one terminal hook for one run",
  );
  expect(terminalEvents).toEqual(["completed"]);
});

test("TanStack abort remains distinct from a human-interaction pause", async () => {
  const terminalEvents: string[] = [];
  const hooks = createTanStackTerminalHooks(({ type }) => {
    terminalEvents.push(type);
  });

  await hooks.onAbort(
    asTestRaw<ChatMiddlewareContext>({}),
    asTestRaw<AbortInfo>({}),
  );

  expect(terminalEvents).toEqual(["aborted"]);
});

test("native AG-UI interrupt completion remains a waiting lifecycle", () => {
  expect(
    tanStackStreamEventLifecycle({
      type: EventType.RUN_FINISHED,
      runId: "run-A",
      threadId: "thread-A",
      outcome: {
        type: "interrupt",
        interrupts: [
          {
            id: "approval_tool-A",
            reason: "tool-approval",
            toolCallId: "tool-A",
          },
        ],
      },
    }),
  ).toBe("waiting");
  expect(
    tanStackStreamEventLifecycle({
      type: EventType.RUN_FINISHED,
      runId: "run-B",
      threadId: "thread-A",
      outcome: { type: "success" },
    }),
  ).toBe("completed");
});

test("a run finish with no outcome completes and a cancelled one is cut short", () => {
  expect(
    tanStackStreamEventLifecycle({
      type: EventType.RUN_FINISHED,
      runId: "run-A",
      threadId: "thread-A",
    }),
  ).toBe("completed");
  expect(
    tanStackStreamEventLifecycle({
      type: EventType.RUN_FINISHED,
      runId: "run-A",
      threadId: "thread-A",
      outcome: { type: "cancelled" },
    }),
  ).toBe("cancelled");
});

test.each(["retry", "fail"] as const)(
  "a pre-output model error remains nonterminal until the %s decision settles",
  async (decision) => {
    const terminalEvents: string[] = [];
    const modelErrors: string[] = [];
    const chunks = await Array.fromAsync(
      chat({
        adapter: createScriptedTextAdapter([
          { type: "error", message: "Temporary model failure" },
          { type: "text", text: "Recovered answer", finishReason: "stop" },
        ]),
        threadId: "lifecycle-retry-thread",
        runId: "lifecycle-retry-run",
        messages: [{ role: "user", content: "Answer" }],
        middleware: [
          {
            onModelError: (context, error) => {
              expect(terminalEvents).toEqual([]);
              modelErrors.push(error.message);
              if (decision === "retry") {
                context.retry();
              }
            },
          },
          createTanStackTerminalHooks(({ type }) => {
            terminalEvents.push(type);
          }),
        ],
      }),
    );
    expect(modelErrors).toEqual(["Temporary model failure"]);
    expect(terminalEvents).toEqual([
      decision === "retry" ? "completed" : "failed",
    ]);
    expect(
      chunks.filter((chunk) => chunk.type === EventType.RUN_ERROR),
    ).toHaveLength(decision === "retry" ? 0 : 1);
    if (decision === "retry") {
      expect(
        chunks.some(
          (chunk) =>
            chunk.type === EventType.TEXT_MESSAGE_CONTENT &&
            chunk.delta === "Recovered answer",
        ),
      ).toBe(true);
    }
  },
);
