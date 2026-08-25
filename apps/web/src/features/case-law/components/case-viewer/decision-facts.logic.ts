import { sanitizeHref } from "@/lib/sanitize-href";

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

const readString = (
  metadata: Record<string, unknown>,
  key: string,
): string | null => {
  const value = metadata[key];
  return isNonEmptyString(value) ? value.trim() : null;
};

const readStringList = (
  metadata: Record<string, unknown>,
  key: string,
): string[] => {
  const value = metadata[key];
  if (isNonEmptyString(value)) {
    return [value.trim()];
  }
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(isNonEmptyString).map((item) => item.trim());
};

export const DECISION_FACT_KEYWORD_LIMIT = 8;

export type DecisionFactsInput = {
  decisionType: string | null | undefined;
  metadata: Record<string, unknown> | null | undefined;
  source: { name: string | null } | null | undefined;
  sourceUrl: string | null | undefined;
};

export type DecisionFacts = {
  decisionType: string | null;
  judge: string | null;
  keywords: string[];
  legalAreas: string[];
  source: { name: string | null; url: string } | null;
  subject: string | null;
};

/**
 * The publisher-supplied facts worth a line above the text. Adapters store
 * them under a handful of keys (`legalArea` for one area, `legalAreas` for
 * several, `subjectOfProceeding`, `keywords`, `judge`); anything else in
 * `metadata` stays out of the reader.
 */
export const buildDecisionFacts = ({
  decisionType,
  metadata,
  source,
  sourceUrl,
}: DecisionFactsInput): DecisionFacts => {
  const record = metadata ?? {};
  const legalAreas = [
    ...readStringList(record, "legalArea"),
    ...readStringList(record, "legalAreas"),
  ];
  const safeSourceUrl = sanitizeHref(sourceUrl);
  return {
    decisionType: isNonEmptyString(decisionType) ? decisionType : null,
    judge: readString(record, "judge"),
    keywords: readStringList(record, "keywords").slice(
      0,
      DECISION_FACT_KEYWORD_LIMIT,
    ),
    legalAreas,
    source:
      safeSourceUrl === undefined
        ? null
        : { name: source?.name ?? null, url: safeSourceUrl },
    subject: readString(record, "subjectOfProceeding"),
  };
};

export const hasDecisionFacts = (facts: DecisionFacts): boolean =>
  facts.decisionType !== null ||
  facts.judge !== null ||
  facts.keywords.length > 0 ||
  facts.legalAreas.length > 0 ||
  facts.source !== null ||
  facts.subject !== null;
