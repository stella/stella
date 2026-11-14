import { describe, expect, test } from "bun:test";

import type { Position } from "@/api/lib/workflow/playbook-positions";
import { answerShapeForPosition } from "@/api/lib/workflow/position-runtime";
import type { GradedPosition } from "@/api/lib/workflow/position-runtime";

const graded = (check: GradedPosition["check"]): Position => ({
  mode: "graded",
  sourceId: "position",
  issue: "Payment terms",
  severity: "medium",
  ask: { mode: "auto" },
  standard: {
    source: "tiers",
    tiers: {
      acceptable: { rules: [{ id: "a", text: "Within 30 days." }] },
      fallback: { entries: [] },
      notAcceptable: { rules: [] },
    },
  },
  ...(check === undefined ? {} : { check }),
  enabled: true,
});

describe("answerShapeForPosition", () => {
  test("only a position the model grades answers with a clause summary", () => {
    expect(answerShapeForPosition(graded(undefined))).toBe("clause-summary");
    expect(
      answerShapeForPosition(
        graded({ kind: "presence", expectation: "required" }),
      ),
    ).toBe("value");
    expect(
      answerShapeForPosition(
        graded({
          kind: "constraint",
          condition: { type: "group", combinator: "and", children: [] },
        }),
      ),
    ).toBe("value");
  });

  test("an extract-only position keeps its value", () => {
    expect(
      answerShapeForPosition({
        mode: "extract",
        sourceId: "position",
        issue: "Payment terms",
        ask: {
          question: "What is the payment term?",
          content: { version: 1, type: "text" },
        },
        enabled: true,
      }),
    ).toBe("value");
  });
});
