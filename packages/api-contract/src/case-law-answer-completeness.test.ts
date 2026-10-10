import { describe, expect, test } from "bun:test";

import {
  CASE_LAW_ANSWER_SURFACE,
  CASE_LAW_INCOMPLETE_REASON,
} from "./case-law-answer-completeness";

describe("case-law incomplete-answer reasons", () => {
  test("every real surface has a non-empty, unique reason set", () => {
    expect(Object.keys(CASE_LAW_INCOMPLETE_REASON).toSorted()).toEqual(
      Object.values(CASE_LAW_ANSWER_SURFACE).toSorted(),
    );
    for (const reasons of Object.values(CASE_LAW_INCOMPLETE_REASON)) {
      expect(reasons.length).toBeGreaterThan(0);
      expect(new Set(reasons).size).toBe(reasons.length);
    }
  });
});
