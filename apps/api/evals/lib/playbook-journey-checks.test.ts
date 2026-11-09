import { describe, expect, test } from "bun:test";

import { UNGRADED_RATIONALE } from "@/api/lib/document-review/review-grade";
import { CUT_DOCUMENT_RATIONALE } from "@/api/lib/workflow/verdict-engine";

import {
  checkBadges,
  checkFindings,
  checkRunProgress,
} from "./playbook-journey-checks";
import type {
  ExpectedTiers,
  RunDetail,
  RunFinding,
} from "./playbook-journey-checks";

const finding = ({
  positionId = "p-fees",
  verdict = "compliant",
  rationale = "Meets the acceptable rules.",
  standardSource = "tiers",
  explanation,
  fix = null,
  suggestionId = null,
}: {
  positionId?: string;
  verdict?: string | null;
  rationale?: string | null;
  standardSource?: string;
  explanation?: { type: string };
  fix?: unknown;
  suggestionId?: string | null;
} = {}): RunFinding => ({
  id: `f-${positionId}`,
  positionId,
  positionTitle: positionId,
  outcome: verdict,
  suggestionId,
  payload: {
    finding: {
      verdict,
      standardSource,
      rationale,
      ...(explanation === undefined ? {} : { explanation }),
      fix,
    },
  },
});

const detail = (
  run: Partial<RunDetail["run"]>,
  findings: RunFinding[],
): RunDetail => ({
  run: {
    id: "run",
    status: "completed",
    executor: "worker",
    errorCode: null,
    total: findings.length,
    completed: findings.length,
    ...run,
  },
  findings,
});

const expected: ExpectedTiers = {
  byPositionId: {
    "p-fees": ["fallback", "compliant"],
    "p-liability": ["deviation"],
  },
  reference: ["compliant", "not-applicable"],
  fixPositionIds: new Set(["p-liability"]),
};

describe("checkRunProgress", () => {
  test("passes a completed run whose progress counts its findings", () => {
    expect(
      checkRunProgress({
        detail: detail({}, [finding()]),
        polls: [{ status: "running", total: 1, completed: 0, findings: 0 }],
        expectedFindings: 1,
      }),
    ).toEqual([]);
  });

  test("reports a run that never completed", () => {
    expect(
      checkRunProgress({
        detail: detail({ status: "running", total: 1, completed: 0 }, []),
        polls: [],
        expectedFindings: 1,
      }),
    ).toEqual([
      "ended running, not completed",
      "0 findings for 1 positions",
      "progress reads 0 of 1 with 0 findings",
    ]);
  });

  test("reports a failed run with its error code", () => {
    expect(
      checkRunProgress({
        detail: detail({ status: "failed", errorCode: "grading_failed" }, [
          finding(),
        ]),
        polls: [],
        expectedFindings: 1,
      }),
    ).toEqual(["ended failed (grading_failed), not completed"]);
  });

  test("reports progress stuck at 0 across polls, not a single gap", () => {
    const stalled = { status: "running", total: 2, completed: 0, findings: 1 };
    const run = detail({}, [finding(), finding({ positionId: "p-liability" })]);
    expect(
      checkRunProgress({ detail: run, polls: [stalled], expectedFindings: 2 }),
    ).toEqual([]);
    expect(
      checkRunProgress({
        detail: run,
        polls: [stalled, stalled],
        expectedFindings: 2,
      }),
    ).toEqual(["progress stayed at 0 with findings recorded across 2 polls"]);
  });
});

describe("checkFindings", () => {
  test("accepts any tier the fixture allows", () => {
    expect(
      checkFindings({
        findings: [
          finding({ verdict: "fallback" }),
          finding({
            positionId: "p-liability",
            verdict: "deviation",
            fix: { ops: [] },
          }),
        ],
        expected,
        expectFixes: true,
      }),
    ).toEqual([]);
  });

  test("reports a missing verdict, a lost comparison and a cut read", () => {
    expect(
      checkFindings({
        findings: [
          finding({ verdict: "missing" }),
          finding({ verdict: "deviation", rationale: UNGRADED_RATIONALE }),
          finding({ verdict: "compliant", rationale: CUT_DOCUMENT_RATIONALE }),
        ],
        expected,
        expectFixes: false,
      }),
    ).toEqual([
      "p-fees: graded missing, but the contract states it",
      "p-fees: the comparison never completed",
      "p-fees: the document was not read in full",
    ]);
  });

  test("reports an unexpected tier and an unknown position", () => {
    expect(
      checkFindings({
        findings: [
          finding({ verdict: "deviation" }),
          finding({ positionId: "p-other" }),
          finding({ verdict: "maybe" }),
        ],
        expected,
        expectFixes: false,
      }),
    ).toEqual([
      "p-fees: graded deviation, expected fallback or compliant",
      "p-other: not a position of the fixture playbook",
      "p-fees: unknown verdict maybe",
    ]);
  });

  test("requires a fix for a panel deviation, from the finding or its suggestion", () => {
    const deviation = { positionId: "p-liability", verdict: "deviation" };
    expect(
      checkFindings({
        findings: [finding(deviation)],
        expected,
        expectFixes: true,
      }),
    ).toEqual(["p-liability: deviation without a proposed fix"]);
    expect(
      checkFindings({
        findings: [finding({ ...deviation, suggestionId: "s-1" })],
        expected,
        expectFixes: true,
      }),
    ).toEqual([]);
    expect(
      checkFindings({
        findings: [finding(deviation)],
        expected,
        expectFixes: false,
      }),
    ).toEqual([]);
  });

  test("accepts not-applicable from a reference only when it was compared", () => {
    const reference = {
      positionId: "p-proposed",
      standardSource: "reference",
      verdict: "not-applicable",
    };
    expect(
      checkFindings({
        findings: [
          finding({ ...reference, explanation: { type: "comparison" } }),
        ],
        expected,
        expectFixes: true,
      }),
    ).toEqual([]);
    expect(
      checkFindings({
        findings: [
          finding({
            ...reference,
            explanation: { type: "insufficient-evidence" },
          }),
        ],
        expected,
        expectFixes: true,
      }),
    ).toEqual(["p-proposed: not compared with the reference"]);
  });
});

describe("checkBadges", () => {
  test("passes cells that match the table run's findings", () => {
    expect(
      checkBadges({
        cellValues: ["deviation", "compliant"],
        findings: [
          finding(),
          finding({ positionId: "p-liability", verdict: "deviation" }),
        ],
      }),
    ).toEqual([]);
  });

  test("reports an unknown tier and cells that disagree", () => {
    expect(
      checkBadges({
        cellValues: ["compliant", null],
        findings: [finding(), finding({ verdict: "fallback" })],
      }),
    ).toEqual([
      "verdict cell holds null, not a known tier",
      "verdict cells [compliant, null] differ from findings [compliant, fallback]",
    ]);
  });
});
