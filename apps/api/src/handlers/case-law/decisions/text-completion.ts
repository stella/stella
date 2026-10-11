import { eq, inArray, sql } from "drizzle-orm";

import type {
  CitationTextIncompleteReason,
  DecisionTextWithheldReason,
} from "@stll/api-contract/case-law-text-field";

import { caseLawDecisions, caseLawSources } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import type { CaseLawPublicReadTransaction } from "@/api/lib/case-law-public-read-db";
import { publishedCaseLawDecision } from "@/api/lib/case-law/published-decisions";
import { redistributableCaseLawSourceFor } from "@/api/lib/case-law/redistribution-sql";
import { citationTextRevisionFingerprintSql } from "@/api/lib/case-law/text-revision";
import { decisionTextWithheldReason } from "@/api/lib/legal-search/corpus-source";
import type { CorpusSourceDescriptor } from "@/api/lib/legal-search/corpus-source";

type DecisionTextCompletionInput = {
  published: boolean;
  redistributable: boolean;
  textRevisionFingerprint: string;
  documentUrl: string | null;
  descriptor: CorpusSourceDescriptor | null;
};

/** Both phases bind the text revision and source disposition to the publication gate. */
export const decisionTextCompletionOf = ({
  published,
  redistributable,
  textRevisionFingerprint,
  documentUrl,
  descriptor,
}: DecisionTextCompletionInput) => ({
  textRevisionFingerprint,
  textEligibilityFingerprint: JSON.stringify([
    published,
    textRevisionFingerprint,
    documentUrl,
    redistributable,
    decisionTextWithheldReason(descriptor),
  ]),
  textWithheldReason: decisionTextWithheldReason(descriptor),
  textIncompleteReason:
    !published || !redistributable ? ("missing_text" as const) : null,
});

export const decisionTextCompletionColumns = {
  published: sql<boolean>`${publishedCaseLawDecision}`,
  redistributable: sql<boolean>`${redistributableCaseLawSourceFor(caseLawSources.descriptor)}`,
  documentUrl: caseLawDecisions.documentUrl,
  textRevisionFingerprint: citationTextRevisionFingerprintSql({
    contentHash: caseLawDecisions.contentHash,
    sections: caseLawDecisions.sections,
  }),
  descriptor: caseLawSources.descriptor,
};

export const decisionTextCompletionGate = sql`(
  ${publishedCaseLawDecision}
  AND ${redistributableCaseLawSourceFor(caseLawSources.descriptor)}
)`;

export type DecisionTextCompletionSnapshot = ReturnType<
  typeof decisionTextCompletionOf
>;

type DecisionTextCompletionCheck =
  | { type: "eligible" }
  | { type: "withheld"; reason: DecisionTextWithheldReason }
  | {
      type: "incomplete";
      reason: Exclude<CitationTextIncompleteReason, "absent_ast">;
    };

/** A current source denial takes precedence over a revision mismatch. */
export const checkDecisionTextCompletion = (
  expectedFingerprint: string,
  current: DecisionTextCompletionSnapshot | undefined,
): DecisionTextCompletionCheck => {
  if (current === undefined || current.textIncompleteReason !== null) {
    return { type: "incomplete", reason: "missing_text" };
  }
  if (current.textWithheldReason !== null) {
    return { type: "withheld", reason: current.textWithheldReason };
  }
  if (current.textEligibilityFingerprint !== expectedFingerprint) {
    return { type: "incomplete", reason: "text_changed" };
  }
  return { type: "eligible" };
};

/** Read every text-return gate for one caller-bounded batch from one snapshot. */
export const readDecisionTextCompletions = async (
  tx: CaseLawPublicReadTransaction,
  decisionIds: readonly SafeId<"caseLawDecision">[],
): Promise<Map<string, DecisionTextCompletionSnapshot>> => {
  if (decisionIds.length === 0) {
    return new Map();
  }
  const rows = await tx
    .select({
      id: caseLawDecisions.id,
      ...decisionTextCompletionColumns,
    })
    .from(caseLawDecisions)
    .innerJoin(caseLawSources, eq(caseLawSources.id, caseLawDecisions.sourceId))
    .where(inArray(caseLawDecisions.id, [...decisionIds]))
    .limit(decisionIds.length);
  return new Map(
    rows.map((row) => [String(row.id), decisionTextCompletionOf(row)]),
  );
};

/** A single-decision read delegates to the same bounded completion owner. */
export const readDecisionTextCompletion = async (
  tx: CaseLawPublicReadTransaction,
  decisionId: SafeId<"caseLawDecision">,
): Promise<DecisionTextCompletionSnapshot | undefined> =>
  (await readDecisionTextCompletions(tx, [decisionId])).get(String(decisionId));

export const decisionTextCompletionReasons = (
  completion: DecisionTextCompletionCheck,
) => ({
  textWithheldReason: completion.type === "withheld" ? completion.reason : null,
  textIncompleteReason:
    completion.type === "incomplete" ? completion.reason : null,
});
