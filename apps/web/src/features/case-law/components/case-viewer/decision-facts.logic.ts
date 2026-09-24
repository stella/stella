import { orderDecisionJudges } from "@/features/case-law/decision-judges";
import type { DecisionJudge } from "@/features/case-law/decision-judges";
import type { PublicCaseLawDecision } from "@/features/case-law/public-decision";
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

type DecisionFactsSource = Pick<PublicCaseLawDecision["source"], "name">;

export type DecisionFactsInput = Pick<
  PublicCaseLawDecision,
  "decisionType" | "judges" | "metadata" | "sourceUrl"
> & { source: DecisionFactsSource };

export type DecisionFacts = {
  decisionType: string | null;
  judges: readonly DecisionJudge[];
  keywords: string[];
  legalAreas: string[];
  source: (DecisionFactsSource & { url: string }) | null;
  subject: string | null;
};

/**
 * The publisher-supplied facts worth a line above the text. Adapters store
 * them under a handful of keys (`legalArea` for one area, `legalAreas` for
 * several, `subjectOfProceeding`, `keywords`); anything else in `metadata`
 * stays out of the reader. The bench is its own field of the read rather
 * than publisher metadata.
 */
export const buildDecisionFacts = ({
  decisionType,
  judges,
  metadata,
  source,
  sourceUrl,
}: DecisionFactsInput): DecisionFacts => {
  const legalAreas = [
    ...readStringList(metadata, "legalArea"),
    ...readStringList(metadata, "legalAreas"),
  ];
  const safeSourceUrl = sanitizeHref(sourceUrl);
  return {
    decisionType: isNonEmptyString(decisionType) ? decisionType : null,
    judges: orderDecisionJudges(judges),
    keywords: readStringList(metadata, "keywords").slice(
      0,
      DECISION_FACT_KEYWORD_LIMIT,
    ),
    legalAreas,
    source:
      safeSourceUrl === undefined
        ? null
        : { name: source.name, url: safeSourceUrl },
    subject: readString(metadata, "subjectOfProceeding"),
  };
};

/**
 * Whether each fact was supplied, one entry per field of `DecisionFacts`: a
 * new fact cannot be added to the shape without deciding what makes it
 * present, and the surfaces below select from these keys rather than from
 * strings of their own.
 */
const FACT_IS_PRESENT = {
  decisionType: (facts) => facts.decisionType !== null,
  judges: (facts) => facts.judges.length > 0,
  keywords: (facts) => facts.keywords.length > 0,
  legalAreas: (facts) => facts.legalAreas.length > 0,
  source: (facts) => facts.source !== null,
  subject: (facts) => facts.subject !== null,
} as const satisfies Record<
  keyof DecisionFacts,
  (facts: DecisionFacts) => boolean
>;

export type DecisionFactKind = keyof typeof FACT_IS_PRESENT;

/** Every fact, in the order a reader reads them. */
export const DECISION_FACT_KINDS = [
  "decisionType",
  "legalAreas",
  "subject",
  "keywords",
  "judges",
  "source",
] as const satisfies readonly DecisionFactKind[];

export const decisionFactIsPresent = (
  facts: DecisionFacts,
  kind: DecisionFactKind,
): boolean => FACT_IS_PRESENT[kind](facts);

/** Whether the selected part of the facts has anything to print. */
export const hasDecisionFacts = ({
  facts,
  kinds,
}: {
  facts: DecisionFacts;
  kinds: readonly DecisionFactKind[];
}): boolean => kinds.some((kind) => decisionFactIsPresent(facts, kind));
