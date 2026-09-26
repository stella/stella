import { DECISION_IDENTIFIER_TYPES } from "@stll/legal-ast/decision-identifier";
import type { DocumentAst } from "@stll/legal-ast/document-ast";

import type { CaseDecisionViewPayload } from "@/components/inspector/case-decision-view";
import type { ReaderAnnotationTarget } from "@/components/legal-reader/annotations/reader-annotation-target";
import { decisionCaseName } from "@/features/case-law/components/case-viewer/decision-text.logic";
import type { PublicCaseLawDecision } from "@/features/case-law/public-decision";

type DecisionCitationFacts = Pick<
  PublicCaseLawDecision,
  | "caseNumber"
  | "caseNumberType"
  | "country"
  | "court"
  | "decisionDate"
  | "decisionType"
  | "ecli"
>;

type DecisionReaderAnnotationTarget = Extract<
  ReaderAnnotationTarget,
  { type: "decision" }
>;

type DecisionInspectorAnnotationTargetOptions = {
  ast: DocumentAst | null;
  decision: DecisionCitationFacts | undefined;
  decisionId: string;
  payload: Pick<CaseDecisionViewPayload, "caseNumber" | "country" | "court">;
};

/**
 * The loaded decision carries the citable facts; the payload's record fields
 * stand in only before the read, so a citation never invents a date or type.
 * The payload does not say what kind of reference its case number is; until
 * the read it counts as the docket, the default kind, and nothing can be
 * quoted before then anyway, since the text arrives with the read.
 */
export const decisionInspectorAnnotationTarget = ({
  ast,
  decision,
  decisionId,
  payload,
}: DecisionInspectorAnnotationTargetOptions): DecisionReaderAnnotationTarget => {
  const caseNumber = decision?.caseNumber ?? payload.caseNumber;

  return {
    type: "decision",
    caseNumber,
    caseNumberType:
      decision?.caseNumberType ?? DECISION_IDENTIFIER_TYPES.CASE_NUMBER,
    country: decision?.country ?? payload.country,
    court: decision?.court ?? payload.court,
    decisionDate: decision?.decisionDate ?? null,
    decisionType: decision?.decisionType ?? null,
    ecli: decision?.ecli ?? null,
    id: decisionId,
    name: decisionCaseName({ ast, caseNumber }),
  };
};
