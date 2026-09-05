/**
 * Due-diligence findings model for the report export.
 *
 * A finding is one graded position on one contract whose verdict tier counts
 * as a red flag. This module owns the finding shape, its derivation from a
 * contract's fields and justifications (pure), the severity/group ordering,
 * and the link index that keeps entity/field/justification ids OUT of the
 * AI-visible data object (see `build-report-data.ts` for the hygiene rule).
 */

import { panic } from "better-result";

import type { JustificationContent } from "@/api/db/schema";
import type { DocumentReviewDecision } from "@/api/lib/document-review/run-contract";
import type { PositionSeverity } from "@/api/lib/workflow/playbook-position-facets";
import type {
  Position,
  ResolvedTiers,
} from "@/api/lib/workflow/playbook-positions";

/** Verdict tiers that count as a finding (a red flag) on the report. */
export const RISK_VERDICT_TIERS = new Set(["deviation", "missing"]);

/** Severity order for "worst finding wins" (index = rank; lower is worse). */
export const SEVERITY_ORDER = ["blocker", "high", "medium", "low"] as const;

export type GradedPosition = Extract<Position, { mode: "graded" }>;

/** One quoted source passage behind a finding.
 *
 *  - `docx`: a folio citation. `grounded` mirrors the extraction's
 *    `citationStatus`: an unverified citation keeps the model's text as a hint
 *    but carries no navigable block (`blockId` is "") and must never be quoted
 *    as source language.
 *  - `pdf`: a bates/page locator; the statement text is the quote. */
export type ReportCitation =
  | { kind: "docx"; blockId: string; text: string; grounded: boolean }
  | { kind: "pdf"; pageNumber: number; bates: string; text: string };

/** The resolved tier reference that decided the verdict (fallback matched or
 *  red line violated), flattened for rendering. `kind: "none"` stands in for
 *  absence: the template-data contract has no null. */
export type ReportMatchedRef =
  | { kind: "fallback" | "redLine"; label: string; text: string }
  | { kind: "none"; label: ""; text: "" };

export const NO_MATCHED_REF: ReportMatchedRef = {
  kind: "none",
  label: "",
  text: "",
};

/** Negotiation guidance authored on the position; all-empty when the position
 *  has none (gated by `ReportFinding.hasNegotiation`). */
export type ReportNegotiation = {
  rationale: string;
  talkingPoints: string[];
  escalation: string;
};

export const EMPTY_NEGOTIATION: ReportNegotiation = {
  rationale: "",
  talkingPoints: [],
  escalation: "",
};

/** Reviewer disposition of a finding: `decision` from the document-review
 *  findings ledger ("none" when the contract has no DOCX review run), `locked`
 *  from the verdict cell's metadata. */
export type ReportFindingReview = {
  locked: boolean;
  decision: DocumentReviewDecision | "none";
};

export type ReportFinding = {
  /** 1-based contract identity (see `ReportContract.index`). */
  contractIndex: number;
  /** 1-based position of this finding within its contract, in column order.
   *  Together with `contractIndex` it addresses the finding in
   *  {@link ReportLinks}. */
  findingIndex: number;
  contractName: string;
  documentType: string;
  issue: string;
  severity: PositionSeverity;
  /** The verdict tier: "deviation" | "missing". */
  verdict: string;
  rationale: string;
  matchedRef: ReportMatchedRef;
  guidance: string;
  /** Ideal language from the verdict tool's tier snapshot (what the verdict was
   *  graded against), else "". */
  idealText: string;
  negotiation: ReportNegotiation;
  /** True when the position authored any negotiation text; gates the section. */
  hasNegotiation: boolean;
  citations: ReportCitation[];
  review: ReportFindingReview;
};

/** Where a citation came from; never AI-visible. */
export type ReportCitationLink = {
  entityId: string;
  fileFieldId: string;
  justificationId: string;
};

/** Link index returned alongside the report data. Keys come from
 *  {@link reportCitationKey}: `${contractIndex}:${findingIndex}:${citationIndex}`
 *  (all 1-based), so a renderer that has a finding and a citation position can
 *  resolve its source without any id crossing into the data object. */
export type ReportLinks = {
  citations: Map<string, ReportCitationLink>;
};

type ReportCitationKeyParts = {
  contractIndex: number;
  findingIndex: number;
  /** 1-based index into `ReportFinding.citations`. */
  citationIndex: number;
};

export const reportCitationKey = ({
  contractIndex,
  findingIndex,
  citationIndex,
}: ReportCitationKeyParts): string =>
  `${contractIndex}:${findingIndex}:${citationIndex}`;

/** Key for the per-contract review decision lookup: the decision ledger is
 *  keyed by (entity, playbook position) and the verdict property carries the
 *  position's `sourceId` as `playbookSourceId`. */
export const reviewDecisionKey = (
  entityId: string,
  positionId: string,
): string => `${entityId}:${positionId}`;

export const severityRank = (severity: PositionSeverity): number =>
  SEVERITY_ORDER.indexOf(severity);

export const worstSeverity = (
  severities: PositionSeverity[],
): PositionSeverity | "ok" => {
  let worst: PositionSeverity | "ok" = "ok";
  let worstRank: number = SEVERITY_ORDER.length;
  for (const severity of severities) {
    const rank = severityRank(severity);
    if (rank !== -1 && rank < worstRank) {
      worstRank = rank;
      worst = severity;
    }
  }
  return worst;
};

/** Blocker → high → medium → low, then contract order; stable for the rest, so
 *  findings of one contract keep their column order. */
export const compareFindings = (a: ReportFinding, b: ReportFinding): number =>
  severityRank(a.severity) - severityRank(b.severity) ||
  a.contractIndex - b.contractIndex ||
  a.findingIndex - b.findingIndex;

type VerdictRationale = {
  rationale: string;
  matchedRef: ReportMatchedRef;
};

const NO_RATIONALE: VerdictRationale = {
  rationale: "",
  matchedRef: NO_MATCHED_REF,
};

/** The verdict's rationale and matched tier reference (playbook-verdict block). */
export const verdictRationaleFromJustification = (
  content: JustificationContent | undefined,
): VerdictRationale => {
  if (!content) {
    return NO_RATIONALE;
  }
  for (const block of content.blocks) {
    if (block.kind !== "playbook-verdict") {
      continue;
    }
    const ref = block.matchedRef;
    const matchedRef: ReportMatchedRef = ref
      ? {
          kind: ref.kind,
          label: ref.kind === "fallback" ? (ref.label ?? "") : "",
          text: ref.text,
        }
      : NO_MATCHED_REF;
    return { rationale: block.rationale, matchedRef };
  }
  return NO_RATIONALE;
};

type ExtractedCitation = {
  citation: ReportCitation;
  fileFieldId: string;
};

/** Every citation of an extraction's justification, in block/statement order.
 *  A docx citation is kept whether or not it is grounded (the flag travels with
 *  it); a pdf citation pairs each locator with its statement text. */
export const citationsFromJustification = (
  content: JustificationContent | undefined,
): ExtractedCitation[] => {
  if (!content) {
    return [];
  }
  const out: ExtractedCitation[] = [];
  for (const block of content.blocks) {
    if (block.kind === "docx-folio") {
      for (const statement of block.statements) {
        for (const cite of statement.citations) {
          if (cite.text.length === 0) {
            continue;
          }
          out.push({
            fileFieldId: block.fileFieldId,
            citation:
              cite.citationStatus === "verified"
                ? {
                    kind: "docx",
                    blockId: cite.blockId,
                    text: cite.text,
                    grounded: true,
                  }
                : {
                    kind: "docx",
                    blockId: "",
                    text: cite.text,
                    grounded: false,
                  },
          });
        }
      }
    }
    if (block.kind === "pdf-bates") {
      for (const statement of block.statements) {
        if (statement.text.length === 0) {
          continue;
        }
        for (const cite of statement.citations) {
          out.push({
            fileFieldId: block.fileFieldId,
            citation: {
              kind: "pdf",
              pageNumber: cite.pageNumber,
              bates: cite.bates,
              text: statement.text,
            },
          });
        }
      }
    }
  }
  return out;
};

/** The first citation safe to quote as source language: a grounded docx quote
 *  or a pdf statement. Unverified docx text is the model's ungrounded hint and
 *  is never quoted. */
export const quotableCitationText = (citations: ReportCitation[]): string => {
  for (const citation of citations) {
    switch (citation.kind) {
      case "docx":
        if (citation.grounded) {
          return citation.text;
        }
        break;
      case "pdf":
        return citation.text;
      default: {
        citation satisfies never;
        return panic(`Unhandled citation: ${String(citation)}`);
      }
    }
  }
  return "";
};

export const idealTextFromTiers = (tiers: ResolvedTiers): string =>
  tiers.ideal ?? "";

export const negotiationFromPosition = (
  position: GradedPosition | undefined,
): ReportNegotiation => {
  const negotiation = position?.negotiation;
  if (!negotiation) {
    return EMPTY_NEGOTIATION;
  }
  // Every negotiation field is optional in the playbook schema; an absent
  // field renders as empty text.
  const { rationale = "", talkingPoints = [], escalation = "" } = negotiation;
  return { rationale, talkingPoints, escalation };
};

export const hasNegotiationText = ({
  rationale,
  talkingPoints,
  escalation,
}: ReportNegotiation): boolean =>
  rationale.length > 0 || talkingPoints.length > 0 || escalation.length > 0;
