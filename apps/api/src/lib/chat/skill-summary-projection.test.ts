import { expect, test } from "bun:test";

import { SKILL_CONTENT_TOOL_NAMES } from "@/api/lib/agent-skills/skill-content-tools";

import { createSkillSummaryProjection } from "./skill-summary-projection";
import { assertToolResultsHaveCalls } from "./tool-history-pairing";

test.each(SKILL_CONTENT_TOOL_NAMES)(
  "summary prefixes omit %s payloads and separately held results without changing other parts",
  (name) => {
    const call = {
      type: "tool-call",
      id: "skill-call",
      name,
      output: { instructions: "CURRENT SKILL SECRET" },
    };
    const result = {
      type: "tool-result",
      toolCallId: call.id,
      content: "CURRENT SKILL SECRET",
    };
    const ordinary = { type: "text", content: "Ordinary conversation" };
    const ordinaryCall = {
      type: "tool-call",
      id: "ordinary",
      name: "read-file",
    };
    const ordinaryResult = {
      type: "tool-result",
      toolCallId: ordinaryCall.id,
      content: "File read",
    };
    const fullBatch = [
      [result, ordinary],
      [call, ordinaryCall, ordinaryResult],
    ];
    assertToolResultsHaveCalls(fullBatch);
    const projection = createSkillSummaryProjection(fullBatch);
    expect(projection.parts(fullBatch.flat())).toEqual([
      ordinary,
      ordinaryCall,
      ordinaryResult,
    ]);
    expect(projection.parts([ordinary]).at(0)).toBe(ordinary);
    expect(projection.parts([result])).toEqual([]);
    expect(projection.includesToolCall(call.id)).toBe(false);
    expect(projection.includesToolCall(ordinaryCall.id)).toBe(true);
    expect(result.content).toBe("CURRENT SKILL SECRET");
    expect(call.output.instructions).toBe("CURRENT SKILL SECRET");
  },
);

test("summary pairing rejects orphan results before any text projection", () => {
  expect(() =>
    createSkillSummaryProjection([
      [{ type: "tool-result", toolCallId: "missing" }],
    ]),
  ).toThrow("Tool result has no matching call");
});
