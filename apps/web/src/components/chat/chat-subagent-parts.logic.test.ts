import { panic } from "better-result";
import { describe, expect, test } from "bun:test";

import { BROWSE_WEB_TOOL_NAME } from "@stll/api-contract/browser-control";
import { CHAT_TOOL_EXECUTOR_METADATA_KEY } from "@stll/api-contract/chat";

import type {
  SubagentChatPart,
  SubagentChildPart,
} from "@/components/chat/chat-subagent-parts.logic";
import { withSubagentRunParts } from "@/components/chat/chat-subagent-parts.logic";
import { turnPhaseFromParts } from "@/components/chat/chat-turn-status.logic";
import {
  getAwaitedAssistantMessageId,
  getCurrentApprovalPendingMessageId,
  hasApprovalResponseAwaitingModelStep,
  hasRunningToolCallInLatestAssistantMessage,
  hasUserAnswerablePart,
  isOpaquePersistedChatToolCallPart,
  openMemberWaitKeys,
  sanitizeRunningToolCalls,
} from "@/components/chat/chat-ui-tools";
import type {
  ChatPart,
  PersistedChatMessage,
} from "@/components/chat/chat-ui-tools";
import { browserTurnId } from "@/features/chat/browser-control/browser-turn";
import { resolveSuggestedPromptsTurnOwner } from "@/features/chat/lib/suggested-prompts-availability";

const openPage = { action: "open", url: "https://www.example.cz/" };

const browserCall = (
  id: string,
  state: Extract<SubagentChildPart, { type: "tool-call" }>["state"],
): SubagentChildPart => ({
  arguments: JSON.stringify(openPage),
  id,
  input: openPage,
  name: "use-browser",
  state,
  type: "tool-call",
  ...(state === "approval-requested" || state === "approval-responded"
    ? {
        approval: {
          id: `${id}-approval`,
          needsApproval: true,
          ...(state === "approval-responded" ? { approved: true } : {}),
        },
      }
    : {}),
});

const run = (
  id: string,
  parts: SubagentChildPart[],
  status: SubagentChatPart["subagent"]["status"] = "running",
): SubagentChatPart => ({
  subagent: {
    id,
    messages: [{ id: `${id}-message`, parts, role: "assistant" }],
    name: BROWSE_WEB_TOOL_NAME,
    parentToolCallId: `${id}-call`,
    status,
  },
  type: "subagent",
});

/** The call that started the run: a tool this release does not register. */
const browseWebCall = (id: string): ChatPart => {
  const call: unknown = {
    arguments: JSON.stringify({ task: "Find the opening hours" }),
    id,
    input: { task: "Find the opening hours" },
    name: BROWSE_WEB_TOOL_NAME,
    state: "input-complete",
    type: "tool-call",
  };
  return isOpaquePersistedChatToolCallPart(call)
    ? call
    : panic("The fixture must be an opaque tool call");
};

const thread = (...parts: ChatPart[]): PersistedChatMessage[] => [
  {
    id: "user",
    parts: [{ content: "When is the registry open?", type: "text" }],
    role: "user",
  },
  { id: "answer", parts, role: "assistant" },
];

describe("a sub-agent run's pending work counts like a top-level one", () => {
  test("its parts follow the run part, nested runs included, in order", () => {
    const inner = run("inner", [browserCall("inner-page", "complete")]);
    const outer = run("outer", [browserCall("outer-page", "complete"), inner]);
    const ids = withSubagentRunParts([outer]).map((part) => {
      if (part.type === "tool-call") {
        return part.id;
      }
      return part.type === "subagent" ? part.subagent.id : part.type;
    });
    expect(ids).toEqual(["outer", "outer-page", "inner", "inner-page"]);
  });

  test("an approval a suspended run asks for, at any depth, is the one the conversation waits on", () => {
    const pending = run(
      "outer",
      [run("inner", [browserCall("page", "approval-requested")], "suspended")],
      "suspended",
    );
    const settled = run(
      "outer",
      [run("inner", [browserCall("page", "complete")], "suspended")],
      "suspended",
    );
    expect(getCurrentApprovalPendingMessageId(thread(pending))).toBe("answer");
    expect(getAwaitedAssistantMessageId(thread(pending))).toBe("answer");
    expect(
      openMemberWaitKeys({ localRunQuestion: null, messages: thread(pending) }),
    ).toEqual(["part:page"]);
    expect(getCurrentApprovalPendingMessageId(thread(settled))).toBeNull();
    expect(getAwaitedAssistantMessageId(thread(settled))).toBeNull();
  });

  test("a run that cannot resume waits on nothing, as the server stores it", () => {
    const waitsOnNothing = (status: SubagentChatPart["subagent"]["status"]) => {
      const stale = run(
        "run",
        [browserCall("page", "approval-requested")],
        status,
      );
      expect(getAwaitedAssistantMessageId(thread(stale))).toBeNull();
      expect(
        openMemberWaitKeys({ localRunQuestion: null, messages: thread(stale) }),
      ).toEqual([]);
      expect(hasUserAnswerablePart([stale])).toBe(false);
    };
    waitsOnNothing("running");
    waitsOnNothing("finished");
    waitsOnNothing("error");
  });

  test("an answered approval inside a run waits on the model's next step", () => {
    expect(
      hasApprovalResponseAwaitingModelStep({
        messages: thread(
          run("run", [browserCall("page", "approval-responded")]),
        ),
      }),
    ).toBe(true);
  });

  test("a run's client call keeps the turn in flight", () => {
    expect(
      hasRunningToolCallInLatestAssistantMessage({
        messages: thread(run("run", [browserCall("page", "input-complete")])),
      }),
    ).toBe(true);
    expect(
      hasRunningToolCallInLatestAssistantMessage({
        messages: thread(run("run", [browserCall("page", "complete")])),
      }),
    ).toBe(false);
  });

  test("a run's approval request is the turn's live phase", () => {
    const parts = [
      browseWebCall("run-call"),
      run("run", [browserCall("page", "approval-requested")], "suspended"),
    ];
    expect(turnPhaseFromParts(parts, (call) => call.name)).toEqual({
      type: "waiting-for-approval",
    });
  });

  test("a run's question owns the turn", () => {
    const question = {
      analysis: "The registry has two branches.",
      questions: [{ question: "Which branch?", reason: "Hours differ." }],
    };
    const [, answer] = thread(
      run("run", [
        {
          arguments: JSON.stringify(question),
          id: "question",
          input: question,
          name: "ask-user",
          state: "input-complete",
          type: "tool-call",
        },
      ]),
    );
    expect(
      resolveSuggestedPromptsTurnOwner({
        approvalPendingMessageId: null,
        hasReopenedAskUser: false,
        lastMessage: answer ?? null,
      }),
    ).toBe("ask-user");
  });

  test("a browser command inside a run is charged to the turn that started it", () => {
    const messages: PersistedChatMessage[] = [
      ...thread(run("run", [browserCall("page", "complete")])),
      {
        id: "later-user",
        parts: [{ content: "And on Saturday?", type: "text" }],
        role: "user",
      },
    ];
    expect(browserTurnId(messages, "page")).toBe("user");
  });
});

describe("hydration settles a sub-agent run's dead calls", () => {
  const settledParts = (messages: PersistedChatMessage[]) =>
    withSubagentRunParts(messages.at(-1)?.parts ?? []).flatMap((part) =>
      part.type === "tool-call" ? [[part.id, part.state] as const] : [],
    );

  test("a running call at any depth becomes an interrupted one", () => {
    const messages = thread(
      run("outer", [
        browserCall("outer-page", "input-complete"),
        run("inner", [browserCall("inner-page", "input-streaming")]),
      ]),
    );
    const sanitized = sanitizeRunningToolCalls(messages);
    expect(settledParts(sanitized)).toEqual([
      ["outer-page", "error"],
      ["inner-page", "error"],
    ]);
    expect(
      hasRunningToolCallInLatestAssistantMessage({ messages: sanitized }),
    ).toBe(false);
  });

  test("a turn that waits on the user keeps its held server call", () => {
    const serverCall: SubagentChildPart = {
      arguments: JSON.stringify(openPage),
      id: "server-step",
      input: openPage,
      metadata: { [CHAT_TOOL_EXECUTOR_METADATA_KEY]: "server" },
      name: "use-browser",
      state: "input-complete",
      type: "tool-call",
    };
    const [user] = thread();
    const awaiting: PersistedChatMessage = {
      id: "answer",
      parts: [run("run", [serverCall])],
      role: "assistant",
      metadata: {
        turnOutcome: {
          interaction: { toolCallId: "server-step", type: "client-tool" },
          type: "awaiting-user",
        },
      },
    };
    const sanitized = sanitizeRunningToolCalls([
      user ?? panic("The fixture thread starts with the user"),
      awaiting,
    ]);
    expect(sanitized.at(-1)).toBe(awaiting);
  });

  test("a settled run is returned as it was", () => {
    const messages = thread(run("run", [browserCall("page", "complete")]));
    expect(sanitizeRunningToolCalls(messages).at(-1)).toBe(messages.at(-1));
  });
});
