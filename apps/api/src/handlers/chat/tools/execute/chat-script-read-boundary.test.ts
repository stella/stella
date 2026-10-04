import { Result } from "better-result";
import { expect, mock, test } from "bun:test";

import { createChatToolDefectMemo } from "@/api/lib/chat/tool-defect-memo";
import {
  CHAT_TOOL_ERROR_KINDS,
  ChatToolError,
} from "@/api/lib/errors/tagged-errors";

import { runChatScriptRead } from "./chat-script-read-boundary";

test("script read successes preserve the registry payload", async () => {
  const payload = { matters: [] };
  const result = Result.ok(payload);
  expect(
    await runChatScriptRead({
      toolName: "list_matters",
      args: {},
      toolDefectMemo: createChatToolDefectMemo(),
      read: async () => result,
    }),
  ).toBe(result);
});

for (const kind of CHAT_TOOL_ERROR_KINDS) {
  test(`${kind} preserves the registry error and its retry policy`, async () => {
    const toolDefectMemo = createChatToolDefectMemo();
    const args = { query: "fixture" };
    const error = new ChatToolError({ kind, message: "Fixture read failure" });
    const read = mock(async () => Result.err(error));
    const props = {
      toolName: "list_matters",
      args,
      toolDefectMemo,
      read,
    } as const;
    const firstRead = await runChatScriptRead(props);
    expect(firstRead.isErr() && firstRead.error).toBe(error);
    expect(toolDefectMemo.isKnownDefect("list_matters", args)).toBe(
      kind === "server-defect",
    );
    const repeatedRead = await runChatScriptRead(props);
    expect(repeatedRead.isErr() && repeatedRead.error).toBeInstanceOf(
      ChatToolError,
    );
    expect(read).toHaveBeenCalledTimes(kind === "server-defect" ? 1 : 2);
    expect(
      toolDefectMemo.isKnownDefect("list_matters", { query: "different" }),
    ).toBe(false);
    expect(createChatToolDefectMemo().isKnownDefect("list_matters", args)).toBe(
      false,
    );
  });
}
