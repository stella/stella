import { describe, expect, test } from "bun:test";

import {
  answerNeedsRun,
  CASE_LAW_RESEARCH_ANSWER_STATES,
} from "./case-law-research";

/**
 * The queue and the results table read the same policy, so a state added to
 * the contract has to be decided here before either side compiles.
 */
describe("which cells a run has to produce", () => {
  test("a cell nobody has asked about yet is run", () => {
    expect(answerNeedsRun({ state: null, stale: false, force: false })).toBe(
      true,
    );
  });

  test("a pending cell is another run's until the stale window passes", () => {
    for (const force of [false, true]) {
      expect(answerNeedsRun({ state: "pending", stale: false, force })).toBe(
        false,
      );
      expect(answerNeedsRun({ state: "pending", stale: true, force })).toBe(
        true,
      );
    }
  });

  test("a failure is retried; an answer, a silent text and a refusal are not", () => {
    const check = { stale: false, force: false };
    expect(answerNeedsRun({ ...check, state: "failed" })).toBe(true);
    expect(answerNeedsRun({ ...check, state: "answered" })).toBe(false);
    expect(answerNeedsRun({ ...check, state: "not_stated" })).toBe(false);
    expect(answerNeedsRun({ ...check, state: "not_allowed" })).toBe(false);
  });

  test("forcing reopens a settled cell, never the source's terms", () => {
    const check = { stale: false, force: true };
    expect(answerNeedsRun({ ...check, state: "answered" })).toBe(true);
    expect(answerNeedsRun({ ...check, state: "not_stated" })).toBe(true);
    expect(answerNeedsRun({ ...check, state: "not_allowed" })).toBe(false);
  });

  test("every state the contract declares has a decision", () => {
    for (const state of CASE_LAW_RESEARCH_ANSWER_STATES) {
      for (const stale of [false, true]) {
        for (const force of [false, true]) {
          expect(typeof answerNeedsRun({ state, stale, force })).toBe(
            "boolean",
          );
        }
      }
    }
  });
});
