import { describe, expect, test } from "bun:test";

import {
  gradedPositionRule,
  resolveEffectiveAsk,
  selectEnabledPositions,
} from "@/api/handlers/playbooks/position-runtime";
import type { Position } from "@/api/handlers/playbooks/positions";

const textContent = { version: 1, type: "text" } as const;
const RULE_ID = "aaaaaaaa-0000-4000-8000-000000000001";

const gradedBase = {
  mode: "graded",
  sourceId: "11111111-1111-4111-8111-111111111111",
  issue: "Governing law",
  severity: "high",
  ask: { mode: "manual", question: "Which law?", content: textContent },
  tiers: {
    acceptable: { rules: [{ id: RULE_ID, text: "England." }] },
    fallback: { entries: [] },
    notAcceptable: { rules: [] },
  },
  enabled: true,
} satisfies Position;

describe("gradedPositionRule — check → rule", () => {
  test("graded without a check grades by LLM tier-match (positionMatch)", () => {
    expect(gradedPositionRule(gradedBase)).toEqual({ kind: "positionMatch" });
  });

  test("a presence check maps to the presence rule", () => {
    expect(
      gradedPositionRule({
        ...gradedBase,
        check: { kind: "presence", expectation: "restricted" },
      }),
    ).toEqual({ kind: "presence", expectation: "restricted" });
  });

  test("a constraint check maps to a propertyConstraint rule", () => {
    const condition = {
      type: "compare",
      left: { type: "property", propertyId: gradedBase.sourceId },
      op: "lte",
      right: { type: "literal", value: 30 },
    } as const;
    expect(
      gradedPositionRule({
        ...gradedBase,
        check: { kind: "constraint", condition },
      }),
    ).toEqual({ kind: "propertyConstraint", condition });
  });
});

describe("resolveEffectiveAsk", () => {
  test("extract positions use their manual ask", () => {
    expect(
      resolveEffectiveAsk({
        mode: "extract",
        sourceId: "22222222-2222-4222-8222-222222222222",
        issue: "Notice period",
        ask: { question: "How long?", content: textContent },
        enabled: true,
      }),
    ).toEqual({ question: "How long?", content: textContent });
  });

  test("graded manual ask passes through", () => {
    expect(resolveEffectiveAsk(gradedBase)).toEqual({
      question: "Which law?",
      content: textContent,
    });
  });

  test("graded auto ask consumes a stored derived ask", () => {
    expect(
      resolveEffectiveAsk({
        ...gradedBase,
        ask: {
          mode: "auto",
          derived: {
            question: "Derived question?",
            content: textContent,
            rulesHash: "hash",
          },
        },
      }),
    ).toEqual({ question: "Derived question?", content: textContent });
  });

  test("graded auto ask with no derivation falls back to a generic text ask over the issue", () => {
    expect(
      resolveEffectiveAsk({ ...gradedBase, ask: { mode: "auto" } }),
    ).toEqual({
      question: gradedBase.issue,
      content: { version: 1, type: "text" },
    });
  });
});

describe("selectEnabledPositions", () => {
  test("drops disabled positions and preserves order", () => {
    const enabledA = { ...gradedBase, sourceId: "id-a", enabled: true };
    const disabled = { ...gradedBase, sourceId: "id-b", enabled: false };
    const enabledC = { ...gradedBase, sourceId: "id-c", enabled: true };

    expect(
      selectEnabledPositions([enabledA, disabled, enabledC]).map(
        (position) => position.sourceId,
      ),
    ).toEqual(["id-a", "id-c"]);
  });
});
