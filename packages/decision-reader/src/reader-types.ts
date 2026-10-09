import type { CourtTierLabel } from "@stll/api-contract/case-law-court-tiers";
import type { CaseLawDecisionLanguageAlternate } from "@stll/api-contract/case-law-decision-route";
import type { DecisionJudgeRole } from "@stll/api-contract/case-law-judges";
import type { ReadDecisionTextFields } from "@stll/api-contract/case-law-text-field";
import type { DecisionPrimaryReferenceType } from "@stll/legal-ast/decision-identifier";
import type { HeadingLevel } from "@stll/legal-ast/document-ast";

import type { ReaderCitationTreatment } from "./citation-treatment";
import type { StatuteCitationAnchor } from "./fallback-legal-anchors";
import type { ProvisionAnchorSource } from "./provision-anchors";

export type ReaderDecision = {
  caseNumber: string;
  caseNumberType: DecisionPrimaryReferenceType;
  country: string;
  court: string;
  courtAbbreviation: string | null;
  courtTier: CourtTierLabel;
  documentAst: unknown;
  documentPending: boolean;
  documentReadFailed: boolean;
  documentUnavailable: boolean;
  fulltext: string | null;
  id: string;
  judges: readonly {
    name: string;
    role: DecisionJudgeRole;
    judgeId: string | null;
    portrait: { url: string; attribution: string } | null;
  }[];
  language: string;
  sourceAttributionUrl: string | null;
  textFields: ReadDecisionTextFields;
};

export type CitedDecisionTarget = {
  caseNumber: string;
  caseNumberType: DecisionPrimaryReferenceType;
  ecli: string | null;
  country: string;
  court: string;
  decisionDate: string | null;
  decisionType?: string | null | undefined;
  id: string;
  language: string | null;
  languageAlternates: readonly CaseLawDecisionLanguageAlternate[] | null;
  slug: string | null;
};
export type CitationAnchorSource = {
  citationText: string;
  decision: CitedDecisionTarget;
  id: string;
  sectionIndex?: number | null | undefined;
  treatment: ReaderCitationTreatment;
};

export type ProvisionViewPayload = {
  documentId: string;
  eli: string;
  jurisdiction: string;
  anchorId: string;
  highlightAnchorId?: string | undefined;
  provisionLabel: string;
  statuteTitle: string;
  versionValidFrom: string | null;
  versionCount: number;
  decisionContext?:
    | { court: string; caseNumber: string; appliedDocumentId: string }
    | undefined;
};
export type ProvisionPreviewData = {
  documentId: string;
  anchorId: string;
  citedAnchorId: string | null;
  language: string;
  headings: readonly { anchorId: string; level: HeadingLevel; text: string }[];
  heading: {
    id: string;
    anchorId: string;
    level: HeadingLevel;
    text: string;
  } | null;
  blocks: readonly { id: string; anchorId: string; text: string }[];
};
export type CitedStatuteTarget = {
  document: {
    country: string;
    eli: string | null;
    id: string;
    slug: string | null;
    versionValidFrom: string | null;
  };
  statuteTitle: string;
};
export type CitedProvisionTarget = {
  document: CitedStatuteTarget["document"];
  payload: ProvisionViewPayload;
  preview: ProvisionPreviewData | null;
};
export type DecisionProvisionAnchor =
  ProvisionAnchorSource<CitedProvisionTarget>;
export type DecisionStatuteCitationAnchor = StatuteCitationAnchor & {
  target: CitedStatuteTarget;
};
