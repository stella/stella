import { uiMessageToModelMessages } from "@tanstack/ai";
import { expect, test } from "bun:test";

import { answerCallsInTheirStep } from "./step-answers";
import type { ChatPart } from "./types";

for (const approved of [false, true]) {
  test(`a step answer preserves the SDK's ${approved ? "approval" : "denial"} outcome`, () => {
    const call = {
      type: "tool-call",
      id: "call-1",
      name: "delete_document",
      arguments: "{}",
      state: "approval-responded",
      approval: { id: "approval_call-1", needsApproval: true, approved },
    } as const satisfies ChatPart;
    const parts = [call, { type: "text", content: "Next step" }] as const;
    const answered = answerCallsInTheirStep(parts);
    expect(answered).toHaveLength(3);
    const answer = answered.at(1);
    expect(answer).toMatchObject({
      type: "tool-result",
      toolCallId: call.id,
      state: approved ? "complete" : "error",
      ...(approved ? {} : { outcome: "denied" }),
    });
    if (answer?.type !== "tool-result") {
      throw new TypeError("The call's step has no tool result");
    }
    expect(answer.outcome).toBe(approved ? undefined : "denied");
    expect(answerCallsInTheirStep(answered)).toBe(answered);

    const native = uiMessageToModelMessages({
      id: "assistant-1",
      role: "assistant",
      parts: [call],
    }).find((message) => message.role === "tool");
    const projected = uiMessageToModelMessages({
      id: "assistant-1",
      role: "assistant",
      parts: [...answered],
    }).find((message) => message.role === "tool");
    expect(projected).toEqual(native);
  });
}
