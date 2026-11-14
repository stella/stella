import type { CourtTierLabel } from "./case-law-court-tiers";
import type { DecisionHeadnotePreview } from "./case-law-text-field";
import type { SafeId } from "./safe-id";

/** Stored facts used by compact decision previews; no document body is read. */
export type CaseLawDecisionSummary = {
  id: SafeId<"caseLawDecision">;
  caseNumber: string;
  court: string;
  courtAbbreviation: string | null;
  courtTier: CourtTierLabel;
  decisionDate: string | null;
  decisionType: string | null;
  headnote: DecisionHeadnotePreview;
  citationCount: number;
  publication: string | null;
};
