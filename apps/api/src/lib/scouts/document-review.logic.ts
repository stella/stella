import { SIGNAL_SEVERITIES, SIGNAL_SEVERITY } from "@stll/api-contract/signals";
import type {
  SignalEvidence,
  SignalSeverity,
} from "@stll/api-contract/signals";

import type { DocumentReviewFindingPayload } from "@/api/lib/document-review/run-contract";
import type { PositionSeverity } from "@/api/lib/workflow/playbook-position-facets";
import type { VerdictTier } from "@/api/lib/workflow/verdict-tiers";

export const REVIEW_FINDINGS_SHOWN_MAX = 5;
export const REVIEW_QUOTE_MAX_CHARS = 300;
/** Verdicts are rule-derived from graded positions, not a model's guess. */
export const REVIEW_SIGNAL_CONFIDENCE = 0.9;

type ContractReviewEvidence = Extract<
  SignalEvidence,
  { kind: "contract.reviewed" }
>;
export type ReviewVerdict = ContractReviewEvidence["verdict"];
export type ReviewSignalFinding = ContractReviewEvidence["findings"][number];

const ESCALATING_POSITION_SEVERITIES: ReadonlySet<PositionSeverity> = new Set([
  "blocker",
  "high",
]);

/**
 * One finding's inbox severity from its verdict tier and the graded
 * position's own severity. Compliant and not-applicable findings carry no
 * inbox weight and return `null`.
 */
export const findingSeverity = (
  verdict: VerdictTier | null,
  positionSeverity: PositionSeverity,
): SignalSeverity | null => {
  switch (verdict) {
    case "deviation":
    case "missing":
      return ESCALATING_POSITION_SEVERITIES.has(positionSeverity)
        ? SIGNAL_SEVERITY.CRITICAL
        : SIGNAL_SEVERITY.WARNING;
    case "fallback":
      return SIGNAL_SEVERITY.NOTICE;
    case "compliant":
    case "not-applicable":
    case null:
      return null;
    default:
      return verdict satisfies never;
  }
};

const severityRank = (severity: SignalSeverity): number =>
  SIGNAL_SEVERITIES.indexOf(severity);

const truncate = (value: string): string =>
  value.length <= REVIEW_QUOTE_MAX_CHARS
    ? value
    : `${value.slice(0, REVIEW_QUOTE_MAX_CHARS - 1)}…`;

/** Playbook findings become inbox findings; reference comparisons are out of scope. */
export const toReviewSignalFindings = (
  payloads: readonly DocumentReviewFindingPayload[],
): ReviewSignalFinding[] =>
  payloads
    .flatMap((payload) => {
      if (payload.checkKind !== "playbook") {
        return [];
      }
      const severity = findingSeverity(
        payload.finding.verdict,
        payload.finding.severity,
      );
      if (severity === null) {
        return [];
      }
      return [
        {
          title: payload.finding.issue,
          severity,
          quote: truncate(payload.finding.rationale ?? payload.finding.issue),
        },
      ];
    })
    .sort((a, b) => severityRank(b.severity) - severityRank(a.severity));

export const reviewVerdict = (
  findings: readonly ReviewSignalFinding[],
): ReviewVerdict => {
  if (findings.some((f) => f.severity === SIGNAL_SEVERITY.CRITICAL)) {
    return "reject";
  }
  if (findings.some((f) => f.severity === SIGNAL_SEVERITY.WARNING)) {
    return "needs-review";
  }
  return "safe";
};

/** The signal's own severity mirrors its strongest finding. */
export const reviewSignalSeverity = (
  verdict: ReviewVerdict,
): SignalSeverity => {
  switch (verdict) {
    case "reject":
      return SIGNAL_SEVERITY.CRITICAL;
    case "needs-review":
      return SIGNAL_SEVERITY.WARNING;
    case "safe":
      return SIGNAL_SEVERITY.INFO;
    default:
      return verdict satisfies never;
  }
};

export const reviewDedupeKey = (runId: string): string => `review:${runId}`;
