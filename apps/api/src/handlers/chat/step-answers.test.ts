import type { ToolCallPart } from "@tanstack/ai";
import { uiMessageToModelMessages } from "@tanstack/ai";
import { expect, test } from "bun:test";

import { TOOL_CALL_STEP_METADATA_KEY } from "@/api/lib/chat/tool-call-step";

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

for (const outcome of ["success", "denied", "cancelled"] as const) {
  test(`a stored ${outcome} result stays with its originating step`, () => {
    const call = (id: string) =>
      ({
        type: "tool-call",
        id,
        name: "delete_document",
        arguments: "{}",
        state: "input-complete",
        metadata: { [TOOL_CALL_STEP_METADATA_KEY]: id },
      }) as const satisfies ToolCallPart;
    const first = call("call-1");
    const second = call("call-2");
    const result = {
      type: "tool-result",
      toolCallId: first.id,
      content: "{}",
      state: outcome === "success" ? "complete" : "error",
      ...(outcome === "success" ? {} : { outcome }),
    } as const satisfies ChatPart;
    const parts = [first, second, result];
    const answered = answerCallsInTheirStep(parts);
    expect(answered).toEqual([first, result, second]);
    expect(answerCallsInTheirStep(answered)).toBe(answered);
    expect(parts).toEqual([first, second, result]);
  });
}
