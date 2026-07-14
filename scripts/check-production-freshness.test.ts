import { describe, expect, test } from "bun:test";

import { evaluateProductionFreshness } from "./check-production-freshness";

describe("production freshness policy", () => {
  test("accepts production at both policy boundaries", () => {
    expect(
      evaluateProductionFreshness({
        lagCommits: 100,
        lagHours: 168,
        maxLagCommits: 100,
        maxLagHours: 168,
      }),
    ).toEqual({ status: "current" });
  });

  test("reports every exceeded boundary", () => {
    expect(
      evaluateProductionFreshness({
        lagCommits: 101,
        lagHours: 169,
        maxLagCommits: 100,
        maxLagHours: 168,
      }),
    ).toEqual({
      reasons: [
        "production is 101 commits behind main (maximum 100)",
        "the oldest unreleased main commit has waited 169 hours (maximum 168)",
      ],
      status: "stale",
    });
  });

  test("does not fail a fresh release merely because main moved", () => {
    expect(
      evaluateProductionFreshness({
        lagCommits: 3,
        lagHours: 12,
        maxLagCommits: 100,
        maxLagHours: 168,
      }),
    ).toEqual({ status: "current" });
  });
});
