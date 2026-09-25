import { describe, expect, test } from "bun:test";

import type { Position } from "@/api/lib/workflow/playbook-positions";

import { scorePlaybookRun } from "./playbook-authoring-score";
import type { PlaybookExpectation } from "./playbook-authoring-score";

const extract = (sourceId: string, issue: string): Position => ({
  mode: "extract",
  sourceId,
  issue,
  ask: {
    question: `What about ${issue}?`,
    content: { version: 1, type: "text" },
  },
  enabled: true,
});

const SEEDED = [extract("a", "Governing law"), extract("b", "Term")];

const expectation = (
  overrides: Partial<PlaybookExpectation> = {},
): PlaybookExpectation => ({
  presentIssues: ["Governing law", "Term", "Notice period"],
  absentIssues: [],
  untouchedSourceIds: ["a", "b"],
  plantedRefusals: [],
  maxPositionsPerCall: 1,
  perspectives: ["buyer"],
  check: () => [],
  ...overrides,
});

const added = [...SEEDED, extract("c", "notice period")];

describe("playbook-authoring scoring", () => {
  test("one accepted call that adds the asked position passes every step", () => {
    const score = scorePlaybookRun({
      calls: [{ input: { positions: [{}] }, refusal: null }],
      expectation: expectation(),
      finalPerspective: "buyer",
      finalPositions: added,
      seededPositions: SEEDED,
      turnError: null,
    });

    expect(score.outcome).toBe("pass");
    expect(score.defects).toEqual([]);
  });

  test("a refused first call that the model recovers from still saves, but was not accepted", () => {
    const score = scorePlaybookRun({
      calls: [
        { input: { positions: [{}] }, refusal: "validation_error" },
        { input: { positions: [{}] }, refusal: null },
      ],
      expectation: expectation(),
      finalPerspective: "buyer",
      finalPositions: added,
      seededPositions: SEEDED,
      turnError: null,
    });

    expect(score.outcome).toBe("partial");
    expect(score.steps).toEqual({
      accepted: false,
      saved: true,
      minimal: true,
      untouched: true,
    });
    expect(score.refusals).toEqual(["validation_error"]);
  });

  test("a refusal the task planted is excused once; a second of its kind is not", () => {
    const run = (refusals: readonly string[]) =>
      scorePlaybookRun({
        calls: [
          ...refusals.map((refusal) => ({ input: {}, refusal })),
          { input: { positions: [{}] }, refusal: null },
        ],
        expectation: expectation({ plantedRefusals: ["conflict"] }),
        finalPerspective: "buyer",
        finalPositions: added,
        seededPositions: SEEDED,
        turnError: null,
      });

    expect(run(["conflict"]).outcome).toBe("pass");
    expect(run(["conflict", "conflict"]).steps.accepted).toBe(false);
    expect(run(["validation_error"]).steps.accepted).toBe(false);
  });

  test("resending the whole playbook fails `minimal` even when the result is right", () => {
    const score = scorePlaybookRun({
      calls: [{ input: { positions: [{}, {}, {}] }, refusal: null }],
      expectation: expectation(),
      finalPerspective: "buyer",
      finalPositions: added,
      seededPositions: SEEDED,
      turnError: null,
    });

    expect(score.steps.minimal).toBe(false);
    expect(score.steps.saved).toBe(true);
  });

  test("a changed bystander fails `untouched`, a missing position fails `saved`", () => {
    const score = scorePlaybookRun({
      calls: [{ input: { positions: [{}] }, refusal: null }],
      expectation: expectation(),
      finalPerspective: "buyer",
      finalPositions: [extract("a", "Governing law"), extract("b", "Duration")],
      seededPositions: SEEDED,
      turnError: null,
    });

    expect(score.steps.untouched).toBe(false);
    expect(score.steps.saved).toBe(false);
    expect(score.defects).toContain("missing position: Term");
  });

  test("a perspective outside the side's values is a defect; the side's omission is not", () => {
    const wrongSide = scorePlaybookRun({
      calls: [{ input: { positions: [{}] }, refusal: null }],
      expectation: expectation({ perspectives: [undefined] }),
      finalPerspective: "neutral",
      finalPositions: added,
      seededPositions: SEEDED,
      turnError: null,
    });
    const omitted = scorePlaybookRun({
      calls: [{ input: { positions: [{}] }, refusal: null }],
      expectation: expectation({ perspectives: [undefined] }),
      finalPerspective: undefined,
      finalPositions: added,
      seededPositions: SEEDED,
      turnError: null,
    });

    expect(wrongSide.steps.saved).toBe(false);
    expect(wrongSide.defects).toEqual([
      "saved scope.perspective neutral; the side maps to undefined",
    ]);
    expect(omitted.defects).toEqual([]);
  });

  test("a run with no save call, and a run the provider failed, are named as such", () => {
    const base = {
      calls: [],
      expectation: expectation({ perspectives: [undefined] }),
      finalPerspective: undefined,
      finalPositions: SEEDED,
      seededPositions: SEEDED,
    };

    expect(scorePlaybookRun({ ...base, turnError: null }).outcome).toBe(
      "no-call",
    );
    expect(scorePlaybookRun({ ...base, turnError: "timeout" }).outcome).toBe(
      "error",
    );
  });
});
