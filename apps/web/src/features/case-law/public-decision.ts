import type { ReadDecisionTextFields } from "@stll/api-contract/case-law-text-field";

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
  language: string;
  languageAlternates: readonly PublicDecisionLanguageAlternate[];
  metadata: Record<string, unknown>;
  slug?: string | null;
  source: { name: string | null } | null;
  sourceAttributionUrl: string | null;
  sourceUrl: string | null;
  textFields: ReadDecisionTextFields;
  updatedAt: Date | string | null;
};
