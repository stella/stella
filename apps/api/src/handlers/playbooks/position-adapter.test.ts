import { describe, expect, test } from "bun:test";

import {
  selectEnginePositions,
  toEnginePosition,
} from "@/api/handlers/playbooks/position-adapter";
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

describe("toEnginePosition — rule mapping", () => {
  test("extract mode maps to an extractOnly rule with no standard", () => {
    const engine = toEnginePosition({
      mode: "extract",
      sourceId: "22222222-2222-4222-8222-222222222222",
      issue: "Notice period",
      ask: { question: "How long?", content: textContent },
      enabled: true,
    });
    expect(engine.rule).toEqual({ kind: "extractOnly" });
    expect(engine.standard).toEqual({ source: "none" });
    expect(engine.ask).toEqual({ question: "How long?", content: textContent });
  });

  test("graded without a check maps to positionMatch", () => {
    expect(toEnginePosition(gradedBase).rule).toEqual({
      kind: "positionMatch",
    });
  });

  test("a presence check maps to the presence rule", () => {
    const engine = toEnginePosition({
      ...gradedBase,
      check: { kind: "presence", expectation: "restricted" },
    });
    expect(engine.rule).toEqual({
      kind: "presence",
      expectation: "restricted",
    });
  });

  test("a constraint check maps to a propertyConstraint rule", () => {
    const condition = {
      type: "compare",
      left: { type: "property", propertyId: gradedBase.sourceId },
      op: "lte",
      right: { type: "literal", value: 30 },
    } as const;
    const engine = toEnginePosition({
      ...gradedBase,
      check: { kind: "constraint", condition },
    });
    expect(engine.rule).toEqual({ kind: "propertyConstraint", condition });
  });
});

describe("toEnginePosition — standard mapping", () => {
  test("inline ideal plus fallback entries becomes an inline standard, ranked by order", () => {
    const engine = toEnginePosition({
      ...gradedBase,
      tiers: {
        acceptable: {
          rules: [],
          ideal: { source: "inline", text: "Preferred." },
        },
        fallback: {
          entries: [
            { id: "e1", text: "First fallback.", label: "A" },
            { id: "e2", text: "Second fallback." },
          ],
        },
        notAcceptable: { rules: [] },
      },
    });
    expect(engine.standard).toEqual({
      source: "inline",
      preferred: "Preferred.",
      fallbacks: [
        { rank: 0, label: "A", text: "First fallback." },
        { rank: 1, text: "Second fallback." },
      ],
    });
  });

  test("clause ideal becomes a clause standard with its pinned version", () => {
    const engine = toEnginePosition({
      ...gradedBase,
      tiers: {
        acceptable: {
          rules: [],
          ideal: {
            source: "clause",
            clauseId: "cccccccc-0000-4000-8000-000000000001",
            clauseVersion: 3,
          },
        },
        fallback: { entries: [] },
        notAcceptable: { rules: [] },
      },
    });
    expect(engine.standard).toEqual({
      source: "clause",
      clauseId: "cccccccc-0000-4000-8000-000000000001",
      clauseVersion: 3,
    });
  });

  test("no ideal and no fallback entries becomes a none standard", () => {
    const engine = toEnginePosition({
      ...gradedBase,
      tiers: {
        acceptable: { rules: [{ id: RULE_ID, text: "Rule only." }] },
        fallback: { entries: [] },
        notAcceptable: { rules: [] },
      },
    });
    expect(engine.standard).toEqual({ source: "none" });
  });
});

describe("toEnginePosition — auto ask", () => {
  test("consumes a stored derived ask when present", () => {
    const engine = toEnginePosition({
      ...gradedBase,
      ask: {
        mode: "auto",
        derived: {
          question: "Derived question?",
          content: textContent,
          rulesHash: "hash",
        },
      },
    });
    expect(engine.ask).toEqual({
      question: "Derived question?",
      content: textContent,
    });
  });

  test("falls back to a generic text ask over the issue when derivation is absent", () => {
    const engine = toEnginePosition({ ...gradedBase, ask: { mode: "auto" } });
    expect(engine.ask).toEqual({
      question: gradedBase.issue,
      content: { version: 1, type: "text" },
    });
  });
});

describe("selectEnginePositions — disabled skipping", () => {
  test("drops disabled positions and preserves order", () => {
    const enabledA = { ...gradedBase, sourceId: "id-a", enabled: true };
    const disabled = { ...gradedBase, sourceId: "id-b", enabled: false };
    const enabledC = { ...gradedBase, sourceId: "id-c", enabled: true };

    const engine = selectEnginePositions([enabledA, disabled, enabledC]);

    expect(engine.map((position) => position.sourceId)).toEqual([
      "id-a",
      "id-c",
    ]);
  });
});
