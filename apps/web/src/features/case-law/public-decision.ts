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
  ecli: string | null;
  fulltext: string | null;
  id: string;
  language: string;
  languageAlternates: readonly PublicDecisionLanguageAlternate[];
  metadata?: Record<string, unknown> | null;
  slug?: string | null;
  source: { name: string | null } | null;
  sourceUrl: string | null;
  updatedAt: Date | string | null;
};
