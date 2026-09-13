/**
 * The significance layer: what later courts made of a decision.
 *
 * It is written from the citation graph, not from the document, so it is
 * fenced separately. The document does not change when a later court
 * distinguishes the decision, so the document fingerprint cannot notice
 * it; `graphFingerprintOf` digests the cited-by neighbourhood instead, and
 * a stored significance whose fingerprint differs from the current one is
 * stale exactly the way an analysis over an old parse is stale.
 *
 * The model is shown structured facts and nothing else. It never reads the
 * citing decisions' text, so it cannot invent a treatment the graph does
 * not record, and the layer is therefore in-app only: an external producer
 * of a document analysis has not seen the corpus and is never asked to
 * guess at it (`case-law.analysis.update` rejects the layer).
 */

import { and, eq } from "drizzle-orm";
import * as v from "valibot";

import type { AnalysisGraphFingerprint } from "@stll/legal-ast/analysis";
import { ANALYSIS_SIGNIFICANCE_MAX_LENGTH } from "@stll/legal-ast/analysis";
import { DECISION_IDENTIFIER_TYPES } from "@stll/legal-ast/decision-identifier";

import {
  caseLawCitations,
  caseLawDecisionIdentifiers,
  caseLawDecisions,
} from "@/api/db/schema";
import { CITATION_KIND } from "@/api/handlers/case-law/citation-kind";
import { treatmentOf } from "@/api/handlers/case-law/decisions/citation-graph";
import { POLARITY } from "@/api/handlers/case-law/polarity/consts";
import type { SafeId } from "@/api/lib/branded-types";
import type { CaseLawPublicReadTransaction } from "@/api/lib/case-law-public-read-db";
import { CITATION_TREATMENTS } from "@/api/lib/case-law/citation-vocabulary";
import type { CitationTreatment } from "@/api/lib/case-law/citation-vocabulary";
import {
  courtWeightFromMap,
  loadCourtWeights,
} from "@/api/lib/case-law/court-weights";

/**
 * Which revision of the significance prompt wrote a stored text. Bump it
 * when the prompt changes what the text says: unlike the document layers,
 * whose fingerprint digests their system prompt, the graph fingerprint
 * digests only the graph, so nothing else would notice a prompt edit.
 */
export const SIGNIFICANCE_PROMPT_VERSION = 1;

/** One decision that cites the subject, reduced to the facts that matter. */
type CitingDecisionFact = {
  id: SafeId<"caseLawDecision">;
  treatment: CitationTreatment;
  /** Court tier from the seeded court-weight table; lower is higher. */
  tier: number;
  /** Whether it was decided after the subject, so it can be a later reading. */
  later: boolean;
};

export type CitationGraphFacts = {
  decisionId: SafeId<"caseLawDecision">;
  citedByCount: number;
  /** Cited-by count per treatment; the vocabulary is the corpus's own. */
  treatmentCounts: Record<CitationTreatment, number>;
  /** Cited-by count per citing-court tier, tier ascending. */
  countsByCourtTier: { tier: number; count: number }[];
  /** Later decisions that read the subject negatively: narrowing or overruling. */
  laterNegativeCount: number;
  /**
   * Whether a publisher stated a reporter/collection citation for the
   * decision. The corpus has no leading-case flag and no collection table,
   * so the presence of a `reporter-citation` identifier is the only
   * evidence of official reporting there is; it is offered to the model as
   * exactly that and no more.
   */
  reportedInCollection: boolean;
  /** Citing decision ids, sorted; the fingerprint's backbone. */
  citingDecisionIds: SafeId<"caseLawDecision">[];
};

const emptyTreatmentCounts = (): Record<CitationTreatment, number> => ({
  negative: 0,
  neutral: 0,
  positive: 0,
  supportive: 0,
  unclassified: 0,
});

/**
 * The subject's cited-by neighbourhood in one pass, plus the two lookups
 * that pass cannot carry: the court-weight map (cached) and whether a
 * publisher reported the decision.
 *
 * Only `precedent` citations count. A `procedural` row names the case's
 * own appeal history, which says nothing about how later courts read it.
 */
export const readCitationGraphFacts = async ({
  decisionId,
  tx,
}: {
  decisionId: SafeId<"caseLawDecision">;
  tx: CaseLawPublicReadTransaction;
}): Promise<CitationGraphFacts | null> => {
  const subject = await tx.query.caseLawDecisions.findFirst({
    where: { id: { eq: decisionId } },
    columns: { id: true, decisionDate: true },
  });
  if (!subject) {
    return null;
  }

  const rows = await tx
    .select({
      citingId: caseLawCitations.citingDecisionId,
      polarity: caseLawCitations.polarity,
      court: caseLawDecisions.court,
      country: caseLawDecisions.country,
      decisionDate: caseLawDecisions.decisionDate,
    })
    .from(caseLawCitations)
    .innerJoin(
      caseLawDecisions,
      eq(caseLawDecisions.id, caseLawCitations.citingDecisionId),
    )
    .where(
      and(
        eq(caseLawCitations.citedDecisionId, decisionId),
        eq(caseLawCitations.kind, CITATION_KIND.PRECEDENT),
      ),
    );

  const reporter = await tx
    .select({ decisionId: caseLawDecisionIdentifiers.decisionId })
    .from(caseLawDecisionIdentifiers)
    .where(
      and(
        eq(caseLawDecisionIdentifiers.decisionId, decisionId),
        eq(
          caseLawDecisionIdentifiers.type,
          DECISION_IDENTIFIER_TYPES.REPORTER_CITATION,
        ),
      ),
    )
    .limit(1);

  const weights = await loadCourtWeights();
  const subjectDate = subject.decisionDate;

  const facts: CitingDecisionFact[] = rows.map((row) => ({
    id: row.citingId,
    treatment: treatmentOf(row.polarity),
    tier: courtWeightFromMap(weights, row.court, row.country).tier,
    later:
      subjectDate !== null &&
      row.decisionDate !== null &&
      row.decisionDate > subjectDate,
  }));

  const treatmentCounts = emptyTreatmentCounts();
  const tierCounts = new Map<number, number>();
  for (const fact of facts) {
    treatmentCounts[fact.treatment] += 1;
    tierCounts.set(fact.tier, (tierCounts.get(fact.tier) ?? 0) + 1);
  }

  return {
    decisionId,
    citedByCount: facts.length,
    treatmentCounts,
    countsByCourtTier: [...tierCounts.entries()]
      .map(([tier, count]) => ({ tier, count }))
      .toSorted((a, b) => a.tier - b.tier),
    laterNegativeCount: facts.filter(
      (fact) => fact.later && fact.treatment === POLARITY.NEGATIVE,
    ).length,
    reportedInCollection: reporter.length > 0,
    citingDecisionIds: facts.map((fact) => fact.id).toSorted(),
  };
};

/**
 * A digest of the neighbourhood: every fact the model is shown, and nothing
 * else. Stable under row order, and it moves whenever the model's input
 * would.
 *
 * Every field of the user message takes part, which is the point. A
 * citation reclassified from neutral to negative moves it though the id set
 * did not; so does a court whose tier changed in the weight registry, and a
 * corrected decision date that turns a citation into a later one. Leaving
 * either of the last two out would freeze an obsolete statement as current
 * for as long as the id set held still.
 */
export const graphFingerprintOf = (
  facts: Pick<
    CitationGraphFacts,
    | "citingDecisionIds"
    | "countsByCourtTier"
    | "laterNegativeCount"
    | "reportedInCollection"
    | "treatmentCounts"
  >,
): AnalysisGraphFingerprint => {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(facts.reportedInCollection ? "reported" : "unreported");
  hasher.update(`\nlater-negative=${String(facts.laterNegativeCount)}`);
  // The corpus's own vocabulary, in its own order: a fixed list rather than
  // a sort, so the digest cannot move because a key order did.
  for (const treatment of CITATION_TREATMENTS) {
    hasher.update(`\n${treatment}=${String(facts.treatmentCounts[treatment])}`);
  }
  // `readCitationGraphFacts` returns these tier-ascending; sorted again here
  // so the digest is a property of the counts, not of the caller's order.
  for (const { count, tier } of [...facts.countsByCourtTier].toSorted(
    (a, b) => a.tier - b.tier,
  )) {
    hasher.update(`\ntier${String(tier)}=${String(count)}`);
  }
  for (const id of facts.citingDecisionIds) {
    hasher.update(`\n${id}`);
  }
  return hasher.digest("hex");
};

/** What the model may return: the statement, nothing else. */
export const significanceOutputSchema = v.strictObject({
  significance: v.pipe(
    v.string(),
    v.minLength(1),
    v.maxLength(ANALYSIS_SIGNIFICANCE_MAX_LENGTH),
  ),
});

export const significanceSystemPrompt = (language: string): string =>
  `You are a legal analyst. You are given STRUCTURED FACTS about how later
courts have cited one decision. You are not given the text of any of them.

Write \`significance\`: what later courts have made of this decision, in at
most ${String(ANALYSIS_SIGNIFICANCE_MAX_LENGTH)} characters, in the language with code "${language}".

Rules

1. Say only what the facts support. You may not name a citing court, a case
   number or a proposition: you were not shown any.
2. Report the shape of the reception: how often it is cited, whether later
   courts follow it or read it against, and whether the citing courts sit
   high or low (tier 1 is the highest court in that jurisdiction).
3. A decision read negatively by later and higher courts is one to rely on
   with care. Say so plainly; do not soften it and do not call it overruled,
   which these facts cannot establish.
4. An uncited decision is not a weak decision, it is an uncited one. A
   recent decision has had less time to be cited. Do not speculate about why.
5. No headings, no lists, no citations. Two to four sentences of prose.`;

export const significanceUserMessage = (facts: CitationGraphFacts): string =>
  `Cited by: ${String(facts.citedByCount)} decisions
Treatment: ${Object.entries(facts.treatmentCounts)
    .map(([treatment, count]) => `${treatment} ${String(count)}`)
    .join(", ")}
Citing courts by tier (1 is highest): ${
    facts.countsByCourtTier.length === 0
      ? "none"
      : facts.countsByCourtTier
          .map(({ count, tier }) => `tier ${String(tier)}: ${String(count)}`)
          .join(", ")
  }
Later decisions reading it negatively: ${String(facts.laterNegativeCount)}
Stated in an official reporter: ${facts.reportedInCollection ? "yes" : "no"}`;
