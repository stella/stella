/**
 * Risk rollup — a deterministic, pure summary of a single-doc playbook
 * review's findings, rendered at the top of the review results so a
 * reviewer sees the contract's shape (an overall risk level, what got
 * flagged, and the handful of issues that matter most) without reading
 * every finding. No LLM call: every field is derived straight from the
 * `PlaybookFinding[]` the review endpoint already returned.
 *
 * `PlaybookFinding.severity` already carries the reviewed position's
 * authored severity (it mirrors `PositionSeverity` from
 * `playbook-types.ts`), so this does not need a separate
 * positionId -> severity lookup against the playbook definition;
 * severity lives on the finding itself.
 */

import type {
  PlaybookFinding,
  PlaybookSeverity,
  PlaybookVerdict,
} from "@/components/ai-suggestions/playbook-review-store";
import { SEVERITY_ORDER } from "@/components/ai-suggestions/playbook-review-store";

export type OverallRisk = "critical" | "high" | "medium" | "low" | "none";

// A compliant or unset (extract-only positions carry no verdict) finding has
// nothing worth raising with the counterparty; only these three verdicts are
// ever "flagged".
const FLAGGED_VERDICTS: readonly PlaybookVerdict[] = Object.freeze([
  "deviation",
  "fallback",
  "missing",
]);

type FlaggedVerdict = Exclude<PlaybookVerdict, "compliant">;

export type FlaggedPlaybookFinding = PlaybookFinding & {
  verdict: FlaggedVerdict;
};

export type RiskVerdictCounts = Record<PlaybookVerdict, number>;

export type RiskTopIssue = {
  positionId: string;
  issue: string;
  severity: PlaybookSeverity;
  verdict: FlaggedVerdict;
};

export type RiskRollup = {
  overallRisk: OverallRisk;
  totalPositions: number;
  flaggedCount: number;
  verdictCounts: RiskVerdictCounts;
  topIssues: readonly RiskTopIssue[];
};

const TOP_ISSUES_LIMIT = 5;

export const isFlaggedPlaybookFinding = (
  finding: PlaybookFinding,
): finding is FlaggedPlaybookFinding =>
  finding.verdict !== null && FLAGGED_VERDICTS.includes(finding.verdict);

export const computeRiskRollup = (
  findings: readonly PlaybookFinding[],
): RiskRollup => {
  const flagged = findings.filter(isFlaggedPlaybookFinding);

  const verdictCounts: RiskVerdictCounts = {
    compliant: 0,
    fallback: 0,
    deviation: 0,
    missing: 0,
  };
  for (const finding of findings) {
    if (finding.verdict !== null) {
      verdictCounts[finding.verdict] += 1;
    }
  }

  const topIssues = flagged
    .slice()
    .sort(
      (a, b) =>
        SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity),
    )
    .slice(0, TOP_ISSUES_LIMIT)
    .map((finding) => ({
      positionId: finding.positionId,
      issue: finding.issue,
      severity: finding.severity,
      verdict: finding.verdict,
    }));

  return {
    overallRisk: computeOverallRisk(flagged),
    totalPositions: findings.length,
    flaggedCount: flagged.length,
    verdictCounts,
    topIssues,
  };
};

// Cascades from most to least severe over the flagged findings only:
//   1. "critical" — a `deviation`/`missing` at `blocker` severity: an
//      outright violation of a non-negotiable position.
//   2. "high" — any flagged finding (including a `fallback`) at `high`
//      severity.
//   3. "medium" — any flagged finding at `medium` severity, OR any
//      `fallback` verdict at all. A fallback is a pre-approved (if
//      non-ideal) alternative rather than an outright violation, so it is
//      only escalated past "medium" through its own severity tier (the
//      "critical" check above is deliberately restricted to
//      deviation/missing) — it always lands at *least* "medium" through
//      this catch-all, even when authored at `low` severity.
//   4. "low" — any remaining flagged finding (a `deviation`/`missing` at
//      `low` severity, since `medium`+ and every `fallback` were already
//      handled above).
//   5. "none" — nothing flagged.
const computeOverallRisk = (
  flagged: readonly FlaggedPlaybookFinding[],
): OverallRisk => {
  const hasBlockerViolation = flagged.some(
    (finding) =>
      finding.severity === "blocker" && finding.verdict !== "fallback",
  );
  if (hasBlockerViolation) {
    return "critical";
  }

  // A blocker-severity fallback is not "critical" (a fallback is pre-approved,
  // non-ideal language), but it must still outrank a plain medium — otherwise
  // the most severe authored tier would score lower than a lesser one.
  const hasHigh = flagged.some((finding) => finding.severity === "high");
  const hasBlockerFallback = flagged.some(
    (finding) =>
      finding.severity === "blocker" && finding.verdict === "fallback",
  );
  if (hasHigh || hasBlockerFallback) {
    return "high";
  }

  const hasMediumOrFallback = flagged.some(
    (finding) =>
      finding.severity === "medium" || finding.verdict === "fallback",
  );
  if (hasMediumOrFallback) {
    return "medium";
  }

  if (flagged.length > 0) {
    return "low";
  }

  return "none";
};
