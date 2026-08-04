import type {
  ChatMiddlewareContext,
  ErrorInfo,
  FinishInfo,
} from "@tanstack/ai";
import { expect, test } from "bun:test";

import { createTanStackTerminalHooks } from "@/api/handlers/chat/tanstack-chat-lifecycle";
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
