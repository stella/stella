import { panic } from "better-result";
import { describe, expect, test } from "bun:test";

import { BROWSE_WEB_TOOL_NAME } from "@stll/api-contract/browser-control";

import type {
  SubagentChatPart,
  SubagentChildMessage,
} from "@/components/chat/chat-subagent-parts.logic";
import {
  pairSubagentRuns,
  subagentRunMessages,
  subagentRunTask,
  subagentRunTitleKey,
} from "@/components/chat/chat-subagent-run.logic";
import { isOpaquePersistedChatToolCallPart } from "@/components/chat/chat-ui-tools";
import type { ChatUIPart } from "@/components/chat/chat-ui-tools";

const openPage = { action: "open", url: "https://www.example.cz/" };

const browseWebCall = (id: string, input: unknown) => {
  const call: unknown = {
    arguments: JSON.stringify(input),
    id,
    input,
    name: BROWSE_WEB_TOOL_NAME,
    state: "complete",
    type: "tool-call",
  };
  return isOpaquePersistedChatToolCallPart(call)
    ? call
    : panic("The fixture must be an opaque tool call");
};

const run = (
  id: string,
  messages: SubagentChildMessage[],
  parentToolCallId?: string,
): SubagentChatPart => ({
  subagent: {
    id,
    messages,
    name: BROWSE_WEB_TOOL_NAME,
    status: "finished",
    ...(parentToolCallId === undefined ? {} : { parentToolCallId }),
  },
  type: "subagent",
});

describe("sub-agent runs in a message", () => {
  test("each run is paired with the call that started it, and only those calls are folded into it", () => {
    const first = run("first-run", [], "first-call");
    const second = run("second-run", [], "second-call");
    const orphan = run("orphan-run", [], "missing-call");
    const parts: ChatUIPart[] = [
      browseWebCall("first-call", { task: "Opening hours" }),
      browseWebCall("second-call", { task: "Fees" }),
      browseWebCall("unrelated-call", { task: "Holidays" }),
      first,
      second,
      orphan,
    ];
    const { callFor, startingCallIds } = pairSubagentRuns(parts);
    expect(callFor(first)?.id).toBe("first-call");
    expect(callFor(second)?.id).toBe("second-call");
    expect(callFor(orphan)).toBeNull();
    expect([...startingCallIds]).toEqual(["first-call", "second-call"]);
  });

  test("the task comes from the starting call's complete input", () => {
    expect(
      subagentRunTask(browseWebCall("call", { task: "  Opening hours  " })),
    ).toBe("Opening hours");
    expect(subagentRunTask(browseWebCall("call", { task: " " }))).toBeNull();
    expect(subagentRunTask(browseWebCall("call", {}))).toBeNull();
    expect(subagentRunTask(null)).toBeNull();
  });

  test("a browsing run has its own title and any other run a generic one", () => {
    expect(subagentRunTitleKey(BROWSE_WEB_TOOL_NAME)).toBe(
      "chat.subagentRun.browseWeb",
    );
    expect(subagentRunTitleKey("summarize")).toBe("chat.subagentRun.generic");
    expect(subagentRunTitleKey("toString")).toBe("chat.subagentRun.generic");
  });

  test("a run's assistant messages render as a message's own; one with a malformed call is unavailable", () => {
    const part = run("run", [
      {
        id: "prompt",
        parts: [{ content: "Find the opening hours", type: "text" }],
        role: "user",
      },
      {
        id: "page",
        parts: [
          {
            arguments: JSON.stringify(openPage),
            id: "open",
            input: openPage,
            name: "use-browser",
            state: "complete",
            type: "tool-call",
          },
          { content: "Open 8:00 to 16:00.", type: "text" },
        ],
        role: "assistant",
      },
      {
        id: "malformed",
        parts: [
          {
            arguments: "[]",
            id: "open-malformed",
            input: [],
            name: "use-browser",
            state: "complete",
            type: "tool-call",
          },
        ],
        role: "assistant",
      },
    ]);
    const messages = subagentRunMessages(part);
    expect(messages.map((entry) => entry.type)).toEqual([
      "message",
      "unavailable",
    ]);
    const [page] = messages;
    const rendered: readonly unknown[] =
      page?.type === "message" ? page.message.parts : [];
    expect(rendered).toEqual(part.subagent.messages.at(1)?.parts ?? []);
  });
});
