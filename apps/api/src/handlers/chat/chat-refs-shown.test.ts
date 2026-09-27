import { describe, expect, test } from "bun:test";

import { chatRefsShownIn } from "@/api/handlers/chat/chat-refs-shown";
import { ASK_USER_TOOL_NAME } from "@/api/handlers/chat/tools/native-chat-tool-names";
import type { ChatPart } from "@/api/handlers/chat/types";

const SERVER_TOOL = "execute_typescript";

describe("the refs an assistant message showed", () => {
  test("are a server tool's output and the text, never an answer a user wrote", () => {
    const listed = { logs: [], result: [{ id: "ent_1" }], success: true };
    const parts = [
      { content: "Two documents", type: "text" },
      {
        arguments: "{}",
        id: "call-1",
        input: {},
        name: SERVER_TOOL,
        output: listed,
        state: "complete",
        type: "tool-call",
      },
      {
        arguments: "{}",
        id: "call-2",
        input: {},
        name: ASK_USER_TOOL_NAME,
        output: { answers: [{ answer: "ent_7", question: "Which?" }] },
        state: "complete",
        type: "tool-call",
      },
      {
        content: JSON.stringify({ answers: [{ answer: "ent_7" }] }),
        state: "complete",
        toolCallId: "call-2",
        type: "tool-result",
      },
    ] satisfies ChatPart[];

    expect(
      chatRefsShownIn({
        isServerTool: (name) => name === SERVER_TOOL,
        parts,
      }),
    ).toEqual({ outputs: [listed], texts: ["Two documents"] });
  });
});
