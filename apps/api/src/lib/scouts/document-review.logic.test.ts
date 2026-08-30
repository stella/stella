import { describe, expect, test } from "bun:test";

import type { DocumentReviewFindingPayload } from "@/api/lib/document-review/run-contract";
import {
  findingSeverity,
  REVIEW_QUOTE_MAX_CHARS,
  reviewSignalSeverity,
  reviewVerdict,
  toReviewSignalFindings,
} from "@/api/lib/scouts/document-review.logic";
import type { PositionSeverity } from "@/api/lib/workflow/playbook-position-facets";
import type { VerdictTier } from "@/api/lib/workflow/verdict-tiers";

const playbookFinding = ({
  issue,
  severity,
  verdict,
  rationale = null,
}: {
  issue: string;
  severity: PositionSeverity;
  verdict: VerdictTier | null;
  rationale?: string | null;
}): DocumentReviewFindingPayload => ({
  finding: {
    positionId: "0198f2a0-5c1e-7a1b-9d3e-4f5a6b7c8d9e",
    issue,
    severity,
    standardSource: "tiers",
    verdict,
    delta: { kind: "language" },
    extracted: null,
    rationale,
    citations: [],
    fix: null,
  },
});

describe("findingSeverity", () => {
  test("maps verdict tier and position severity", () => {
    expect(findingSeverity("deviation", "blocker")).toBe("critical");
    expect(findingSeverity("missing", "high")).toBe("critical");
    expect(findingSeverity("deviation", "medium")).toBe("warning");
    expect(findingSeverity("fallback", "blocker")).toBe("notice");
    expect(findingSeverity("compliant", "blocker")).toBeNull();
    expect(findingSeverity("additional", "blocker")).toBeNull();
    expect(findingSeverity("not-applicable", "high")).toBeNull();
    expect(findingSeverity(null, "high")).toBeNull();
  });
});

describe("toReviewSignalFindings", () => {
  test("keeps playbook findings with weight, sorted by severity, quoting the rationale", () => {
    const longRationale = "x".repeat(REVIEW_QUOTE_MAX_CHARS + 50);
    const findings = toReviewSignalFindings([
      playbookFinding({
        issue: "Liability cap",
        severity: "medium",
        verdict: "deviation",
        rationale: "Cap set at 50% of fees; playbook requires 100%.",
      }),
      playbookFinding({
        issue: "Governing law",
        severity: "blocker",
        verdict: "missing",
        rationale: longRationale,
      }),
      playbookFinding({
        issue: "Term",
        severity: "low",
        verdict: "compliant",
      }),
      // Graded against a reference standard, not an authored ladder: out of
      // inbox scope however it is graded.
      {
        finding: {
          positionId: "0198f2a0-5c1e-7a1b-9d3e-4f5a6b7c8d9f",
          issue: "Payment terms",
          severity: "blocker",
          standardSource: "reference",
          verdict: "deviation",
          delta: { kind: "language" },
          extracted: null,
          rationale: "Net 60 vs Net 30.",
          citations: [],
          fix: null,
        },
      },
    ]);
    expect(findings.map((f) => [f.title, f.severity])).toEqual([
      ["Governing law", "critical"],
      ["Liability cap", "warning"],
    ]);
    expect(findings.at(0)?.quote.length).toBe(REVIEW_QUOTE_MAX_CHARS);
    expect(findings.at(1)?.quote).toBe(
      "Cap set at 50% of fees; playbook requires 100%.",
    );
  });
});

describe("reviewVerdict", () => {
  test("escalates to the strongest finding and maps to a signal severity", () => {
    const warning = { title: "a", severity: "warning" as const, quote: "q" };
    const notice = { title: "b", severity: "notice" as const, quote: "q" };
    const critical = { title: "c", severity: "critical" as const, quote: "q" };
    expect(reviewVerdict([])).toBe("safe");
    expect(reviewVerdict([notice])).toBe("safe");
    expect(reviewVerdict([notice, warning])).toBe("needs-review");
    expect(reviewVerdict([warning, critical])).toBe("reject");
    expect(reviewSignalSeverity("reject")).toBe("critical");
    expect(reviewSignalSeverity("needs-review")).toBe("warning");
    expect(reviewSignalSeverity("safe")).toBe("info");
  });
});
