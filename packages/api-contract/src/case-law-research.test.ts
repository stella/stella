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
    expect(answerNeedsRun({ state: null, stale: false })).toBe(true);
  });

  test("a pending cell is another run's until the stale window passes", () => {
    expect(answerNeedsRun({ state: "pending", stale: false })).toBe(false);
    expect(answerNeedsRun({ state: "pending", stale: true })).toBe(true);
  });

  test("a failure is retried; an answer and a refusal are not", () => {
    expect(answerNeedsRun({ state: "failed", stale: false })).toBe(true);
    expect(answerNeedsRun({ state: "answered", stale: false })).toBe(false);
    expect(answerNeedsRun({ state: "not_allowed", stale: false })).toBe(false);
  });

  test("every state the contract declares has a decision", () => {
    for (const state of CASE_LAW_RESEARCH_ANSWER_STATES) {
      expect(typeof answerNeedsRun({ state, stale: false })).toBe("boolean");
      expect(typeof answerNeedsRun({ state, stale: true })).toBe("boolean");
    }
  });
});
