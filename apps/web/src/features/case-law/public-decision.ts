import type { DecisionReadResolution } from "@stll/api-contract/case-law-decision-resolution";
import type { ReadDecisionTextFields } from "@stll/api-contract/case-law-text-field";

import type { DecisionJudge } from "@/features/case-law/decision-judges";

export type PublicDecisionLanguageAlternate = {
  caseNumber: string;
  country: string;
  court: string;
  decisionDate: Date | string | null;
  id: string;
  language: string;
  slug: string | null;
};

export type PublicCaseLawDecision = {
  caseNumber: string;
  country: string;
  court: string;
  /**
   * The court's chip, as the read derived it from the court registry: both
   * fields together or neither, since the chip is weighted by the tier. A
   * read that could not reach the registry states no abbreviation.
   */
  courtAbbreviation?: string | null | undefined;
  courtTier?: string | null | undefined;
  decisionDate: Date | string | null;
  decisionType: string | null;
  documentAst: unknown;
  /** Why the text is absent when it is; see `decision-body-state.logic`. */
  documentPending: boolean;
  documentReadFailed: boolean;
  documentUnavailable: boolean;
  ecli: string | null;
  fulltext: string | null;
  id: string;
  /** The bench, rapporteur first, as the read orders it. */
  judges: readonly DecisionJudge[];
  language: string;
  languageAlternates: readonly PublicDecisionLanguageAlternate[];
  metadata: Record<string, unknown>;
  /** Whether the requested address named this decision or a part absorbed into it. */
  resolution: DecisionReadResolution;
  slug: string | null;
  source: { name: string | null } | null;
  sourceAttributionUrl: string | null;
  sourceUrl: string | null;
  textFields: ReadDecisionTextFields;
  updatedAt: Date | string | null;
};
