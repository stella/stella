import { describe, expect, test } from "bun:test";

import type {
  PlaybookFinding,
  PlaybookSeverity,
} from "@/components/ai-suggestions/playbook-review-store";

import {
  computeRiskRollup,
  isFlaggedPlaybookFinding,
} from "./playbook-risk-rollup";

// A large input space (any combination of severity x verdict across an
// unbounded number of positions) makes per-example assertions weak;
// this suite instead pins the documented threshold invariants of
// `computeOverallRisk` plus the counts/topIssues contract.
const finding = (
  overrides: Partial<PlaybookFinding> & { positionId: string },
): PlaybookFinding => ({
  issue: "issue",
  severity: "low",
  verdict: "compliant",
  extracted: null,
  rationale: null,
  citations: [],
  fix: null,
  ...overrides,
});

describe("computeRiskRollup — overallRisk thresholds", () => {
  test("a blocker-severity deviation is critical", () => {
    const rollup = computeRiskRollup([
      finding({ positionId: "1", severity: "blocker", verdict: "deviation" }),
    ]);
    expect(rollup.overallRisk).toBe("critical");
  });

  test("a blocker-severity missing finding is critical", () => {
    const rollup = computeRiskRollup([
      finding({ positionId: "1", severity: "blocker", verdict: "missing" }),
    ]);
    expect(rollup.overallRisk).toBe("critical");
  });

  test("a blocker-severity fallback is high, not critical", () => {
    // A fallback is pre-approved, non-ideal language, so it is never critical;
    // but at blocker severity it must still outrank a plain medium.
    const rollup = computeRiskRollup([
      finding({ positionId: "1", severity: "blocker", verdict: "fallback" }),
    ]);
    expect(rollup.overallRisk).toBe("high");
  });

  test("a medium-severity fallback stays medium", () => {
    const rollup = computeRiskRollup([
      finding({ positionId: "1", severity: "medium", verdict: "fallback" }),
    ]);
    expect(rollup.overallRisk).toBe("medium");
  });

  test("a high-severity deviation is high (with no blocker present)", () => {
    const rollup = computeRiskRollup([
      finding({ positionId: "1", severity: "high", verdict: "deviation" }),
    ]);
    expect(rollup.overallRisk).toBe("high");
  });

  test("a high-severity fallback is also high", () => {
    const rollup = computeRiskRollup([
      finding({ positionId: "1", severity: "high", verdict: "fallback" }),
    ]);
    expect(rollup.overallRisk).toBe("high");
  });

  test("only a fallback (any severity) is medium", () => {
    const rollup = computeRiskRollup([
      finding({ positionId: "1", severity: "low", verdict: "fallback" }),
    ]);
    expect(rollup.overallRisk).toBe("medium");
  });

  test("a medium-severity deviation is medium", () => {
    const rollup = computeRiskRollup([
      finding({ positionId: "1", severity: "medium", verdict: "deviation" }),
    ]);
    expect(rollup.overallRisk).toBe("medium");
  });

  test("only low-severity deviations/missing is low", () => {
    const rollup = computeRiskRollup([
      finding({ positionId: "1", severity: "low", verdict: "deviation" }),
      finding({ positionId: "2", severity: "low", verdict: "missing" }),
    ]);
    expect(rollup.overallRisk).toBe("low");
  });

  test("all compliant is none", () => {
    const rollup = computeRiskRollup([
      finding({ positionId: "1", severity: "blocker", verdict: "compliant" }),
      finding({ positionId: "2", severity: "high", verdict: "compliant" }),
    ]);
    expect(rollup.overallRisk).toBe("none");
  });

  test("no findings is none", () => {
    const rollup = computeRiskRollup([]);
    expect(rollup.overallRisk).toBe("none");
  });

  test("an extract-only finding (null verdict) never counts as flagged", () => {
    const rollup = computeRiskRollup([
      finding({ positionId: "1", severity: "blocker", verdict: null }),
    ]);
    expect(rollup.overallRisk).toBe("none");
    expect(rollup.flaggedCount).toBe(0);
  });

  test("the highest tier wins regardless of finding order", () => {
    const rollup = computeRiskRollup([
      finding({ positionId: "1", severity: "low", verdict: "deviation" }),
      finding({ positionId: "2", severity: "medium", verdict: "fallback" }),
      finding({ positionId: "3", severity: "blocker", verdict: "deviation" }),
      finding({ positionId: "4", severity: "high", verdict: "missing" }),
    ]);
    expect(rollup.overallRisk).toBe("critical");
  });
});

describe("computeRiskRollup — counts", () => {
  test("totals positions reviewed, flagged, and the verdict breakdown", () => {
    const rollup = computeRiskRollup([
      finding({ positionId: "1", severity: "blocker", verdict: "deviation" }),
      finding({ positionId: "2", severity: "medium", verdict: "fallback" }),
      finding({ positionId: "3", severity: "low", verdict: "missing" }),
      finding({ positionId: "4", severity: "low", verdict: "compliant" }),
      finding({ positionId: "5", severity: "medium", verdict: null }),
    ]);

    expect(rollup.totalPositions).toBe(5);
    expect(rollup.flaggedCount).toBe(3);
    expect(rollup.verdictCounts).toEqual({
      compliant: 1,
      fallback: 1,
      deviation: 1,
      missing: 1,
    });
  });
});

describe("review issue selection", () => {
  test("keeps fallback and violations while hiding compliant and extract-only results", () => {
    const findings = [
      finding({ positionId: "compliant", verdict: "compliant" }),
      finding({ positionId: "fallback", verdict: "fallback" }),
      finding({ positionId: "deviation", verdict: "deviation" }),
      finding({ positionId: "missing", verdict: "missing" }),
      finding({ positionId: "extract", verdict: null }),
    ];

    expect(
      findings
        .filter(isFlaggedPlaybookFinding)
        .map((result) => result.positionId),
    ).toEqual(["fallback", "deviation", "missing"]);
  });
});

describe("computeRiskRollup — topIssues", () => {
  test("orders flagged findings blocker -> low and drops compliant/null", () => {
    const rollup = computeRiskRollup([
      finding({ positionId: "low", severity: "low", verdict: "deviation" }),
      finding({
        positionId: "blocker",
        severity: "blocker",
        verdict: "missing",
      }),
      finding({
        positionId: "compliant",
        severity: "high",
        verdict: "compliant",
      }),
      finding({
        positionId: "medium",
        severity: "medium",
        verdict: "fallback",
      }),
      finding({ positionId: "extract", severity: "high", verdict: null }),
      finding({ positionId: "high", severity: "high", verdict: "deviation" }),
    ]);

    expect(rollup.topIssues.map((issue) => issue.positionId)).toEqual([
      "blocker",
      "high",
      "medium",
      "low",
    ]);
  });

  test("caps top issues to 5 even with more flagged findings", () => {
    const severities: PlaybookSeverity[] = [
      "blocker",
      "blocker",
      "high",
      "high",
      "medium",
      "medium",
      "low",
      "low",
    ];
    const rollup = computeRiskRollup(
      severities.map((severity, index) =>
        finding({
          positionId: `p${index}`,
          severity,
          verdict: "deviation",
        }),
      ),
    );

    expect(rollup.topIssues.length).toBe(5);
    expect(rollup.flaggedCount).toBe(8);
    // The two lowest-severity flags (positions 6 and 7) are cut.
    expect(rollup.topIssues.map((issue) => issue.positionId)).not.toContain(
      "p7",
    );
  });

  test("carries the issue text, severity, and verdict for each top issue", () => {
    const rollup = computeRiskRollup([
      finding({
        positionId: "1",
        issue: "Limitation of liability is uncapped",
        severity: "blocker",
        verdict: "deviation",
      }),
    ]);

    expect(rollup.topIssues).toEqual([
      {
        positionId: "1",
        issue: "Limitation of liability is uncapped",
        severity: "blocker",
        verdict: "deviation",
      },
    ]);
  });
});
