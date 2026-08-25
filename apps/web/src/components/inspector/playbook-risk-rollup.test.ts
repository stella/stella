import { describe, expect, test } from "bun:test";

import type {
  ReviewFinding,
  ReviewSeverity,
} from "@/components/ai-suggestions/document-review-queries";

import {
  computeRiskRollup,
  isFlaggedReviewFinding,
} from "./playbook-risk-rollup";

// A large input space (any combination of severity x verdict across an
// unbounded number of positions) makes per-example assertions weak;
// this suite instead pins the documented threshold invariants of
// `computeOverallRisk` plus the counts/topIssues contract.
const finding = (
  overrides: Partial<ReviewFinding> & { positionId: string },
): ReviewFinding => ({
  issue: "issue",
  severity: "low",
  standardSource: "tiers",
  verdict: "compliant",
  delta: { kind: "language" },
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
      finding({
        positionId: "6",
        severity: "blocker",
        verdict: "not-applicable",
      }),
    ]);

    expect(rollup.totalPositions).toBe(6);
    // A not-applicable position (even at blocker severity) is never flagged.
    expect(rollup.flaggedCount).toBe(3);
    expect(rollup.verdictCounts).toEqual({
      compliant: 1,
      fallback: 1,
      deviation: 1,
      missing: 1,
      additional: 0,
      "not-applicable": 1,
    });
  });

  test("an additional term sits outside the ladder, like not-applicable", () => {
    const rollup = computeRiskRollup([
      finding({ positionId: "1", severity: "blocker", verdict: "additional" }),
      finding({ positionId: "2", verdict: "compliant" }),
    ]);

    expect(rollup.flaggedCount).toBe(0);
    expect(rollup.overallRisk).toBe("none");
    expect(rollup.compliance.scored).toBe(1);
    expect(rollup.compliance.notApplicable).toBe(1);
  });

  test("a not-applicable position is never a flag or a top issue", () => {
    const rollup = computeRiskRollup([
      finding({
        positionId: "na",
        severity: "blocker",
        verdict: "not-applicable",
      }),
    ]);
    expect(rollup.overallRisk).toBe("none");
    expect(rollup.flaggedCount).toBe(0);
    expect(rollup.topIssues).toHaveLength(0);
    expect(
      isFlaggedReviewFinding(
        finding({ positionId: "na", verdict: "not-applicable" }),
      ),
    ).toBe(false);
  });
});

// The score-math invariants: a not-applicable position must never enter the
// denominator (a document that legitimately omits a topic is not penalized),
// while a `missing` gap must stay in it (a real omission counts against
// compliance). `met` = compliant + fallback; `notMet` = deviation + missing.
describe("computeRiskRollup — compliance score", () => {
  test("excludes not-applicable from the denominator but keeps missing in it", () => {
    const rollup = computeRiskRollup([
      finding({ positionId: "1", verdict: "compliant" }),
      finding({ positionId: "2", verdict: "fallback" }),
      finding({ positionId: "3", verdict: "deviation" }),
      finding({ positionId: "4", verdict: "missing" }),
      finding({ positionId: "5", verdict: "not-applicable" }),
      finding({ positionId: "6", verdict: "not-applicable" }),
      // Extract-only positions carry no verdict and are excluded too.
      finding({ positionId: "7", verdict: null }),
    ]);

    // met = compliant + fallback = 2; notMet = deviation + missing = 2.
    expect(rollup.compliance.met).toBe(2);
    expect(rollup.compliance.notMet).toBe(2);
    // Denominator excludes the two not-applicable and the one extract-only.
    expect(rollup.compliance.scored).toBe(4);
    expect(rollup.compliance.notApplicable).toBe(2);
    expect(rollup.compliance.ratio).toBe(0.5);
  });

  test("marking a flagged position not-applicable raises the score by shrinking the denominator", () => {
    const withMissing = computeRiskRollup([
      finding({ positionId: "1", verdict: "compliant" }),
      finding({ positionId: "2", verdict: "missing" }),
    ]);
    // 1 met / 2 scored.
    expect(withMissing.compliance.ratio).toBe(0.5);

    const asNotApplicable = computeRiskRollup([
      finding({ positionId: "1", verdict: "compliant" }),
      finding({ positionId: "2", verdict: "not-applicable" }),
    ]);
    // The same position, now out of scope, leaves 1 met / 1 scored.
    expect(asNotApplicable.compliance.scored).toBe(1);
    expect(asNotApplicable.compliance.ratio).toBe(1);
  });

  test("ratio is null when nothing is scored (all not-applicable or extract-only)", () => {
    const rollup = computeRiskRollup([
      finding({ positionId: "1", verdict: "not-applicable" }),
      finding({ positionId: "2", verdict: null }),
    ]);
    expect(rollup.compliance.scored).toBe(0);
    expect(rollup.compliance.ratio).toBeNull();
  });

  test("empty findings produce a null ratio, not a divide-by-zero", () => {
    const rollup = computeRiskRollup([]);
    expect(rollup.compliance.ratio).toBeNull();
    expect(rollup.compliance.scored).toBe(0);
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
        .filter(isFlaggedReviewFinding)
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
    const severities: ReviewSeverity[] = [
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
