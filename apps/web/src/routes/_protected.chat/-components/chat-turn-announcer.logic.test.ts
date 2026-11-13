import { describe, expect, test } from "bun:test";

import { ASK_USER_TOOL_NAME } from "@stll/api-contract/chat";

import type { ChatUIMessage } from "@/components/chat/chat-ui-tools";
import { turnAnnouncement } from "@/routes/_protected.chat/-components/chat-turn-announcer.logic";

type Outcome = NonNullable<
  NonNullable<ChatUIMessage["metadata"]>["turnOutcome"]
>;

const question = {
  id: "question",
  role: "user",
  parts: [{ type: "text", content: "Check the lease." }],
} satisfies ChatUIMessage;

const answer = (
  outcome: Outcome | undefined,
  parts: ChatUIMessage["parts"] = [
    { type: "text", content: "The lease ends in May." },
  ],
): ChatUIMessage => ({
  id: "answer",
  role: "assistant",
  parts,
  ...(outcome === undefined ? {} : { metadata: { turnOutcome: outcome } }),
});

const announced = (
  messages: ChatUIMessage[],
  state: { isGenerating?: boolean; hasError?: boolean } = {},
) =>
  turnAnnouncement({
    messages,
    isGenerating: state.isGenerating ?? false,
    hasError: state.hasError ?? false,
  })?.announcement ?? null;

describe("what the thread announces about its turn", () => {
  test("each way a turn ends", () => {
    const cases: [Outcome, ReturnType<typeof announced>][] = [
      [{ type: "completed" }, "done"],
      [{ type: "cancelled", reason: "user-stop" }, "stopped"],
      // The member's next message took over; nothing ended for them.
      [{ type: "cancelled", reason: "superseded" }, null],
      [{ type: "failed", error: "provider_unavailable" }, "failed"],
      [{ type: "interrupted", reason: "timeout" }, "failed"],
      [
        {
          type: "awaiting-user",
          interaction: { type: "approval", toolCallId: "call" },
        },
        "needs-approval",
      ],
      [
        {
          type: "awaiting-user",
          interaction: { type: "harness-question", toolCallId: "call" },
        },
        "has-question",
      ],
      // The page answers its own client tool; the member is not asked.
      [
        {
          type: "awaiting-user",
          interaction: { type: "client-tool", toolCallId: "call" },
        },
        null,
      ],
    ];
    for (const [outcome, expected] of cases) {
      expect(announced([question, answer(outcome)])).toBe(expected);
    }
  });

  test("a pending approval or question is read from the answer's parts, live", () => {
    const approval = answer(undefined, [
      {
        type: "tool-call",
        id: "call",
        name: "delete_document",
        arguments: "{}",
        state: "approval-requested",
      },
    ]);
    expect(announced([question, approval], { isGenerating: true })).toBe(
      "needs-approval",
    );
    const asked = answer(undefined, [
      {
        type: "tool-call",
        id: "call",
        name: ASK_USER_TOOL_NAME,
        arguments: "{}",
        state: "input-complete",
      },
    ]);
    expect(announced([question, asked])).toBe("has-question");
  });

  test("a running turn is not narrated", () => {
    expect(
      announced([question, answer({ type: "completed" })], {
        isGenerating: true,
      }),
    ).toBeNull();
    expect(announced([question], { isGenerating: true })).toBeNull();
  });

  test("a turn the chat client failed is a failure, before any outcome", () => {
    expect(announced([question, answer(undefined)], { hasError: true })).toBe(
      "failed",
    );
  });

  test("an answer from before outcomes, or an empty thread, says nothing", () => {
    expect(announced([question, answer(undefined)])).toBeNull();
    expect(announced([])).toBeNull();
  });

  test("a waiting phase is about the calls that wait on the member only", () => {
    const pending = {
      type: "tool-call",
      id: "approve",
      name: "delete_document",
      arguments: "{}",
      state: "approval-requested",
    } as const;
    const beside = {
      type: "tool-call",
      id: "search",
      name: "search_documents",
      arguments: "{}",
    } as const;
    const subject = (parts: ChatUIMessage["parts"]) =>
      turnAnnouncement({
        messages: [question, answer(undefined, parts)],
        isGenerating: true,
        hasError: false,
      })?.subject;
    // A tool that runs beside the approval, then ends, changes nothing said.
    expect(subject([pending, { ...beside, state: "input-complete" }])).toBe(
      "approve",
    );
    expect(subject([pending])).toBe("approve");
  });

  test("a waiting outcome is about its call, an ended one about its answer", () => {
    const subject = (outcome: Outcome) =>
      turnAnnouncement({
        messages: [question, answer(outcome)],
        isGenerating: false,
        hasError: false,
      })?.subject;
    expect(
      subject({
        type: "awaiting-user",
        interaction: { type: "harness-question", toolCallId: "first" },
      }),
    ).toBe("first");
    expect(
      subject({
        type: "awaiting-user",
        interaction: { type: "harness-question", toolCallId: "second" },
      }),
    ).toBe("second");
    expect(subject({ type: "completed" })).toBe("answer");
  });
});
