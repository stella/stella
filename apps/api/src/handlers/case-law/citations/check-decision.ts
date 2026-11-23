/**
 * The typed judgment behind a citation check.
 *
 * "Does this decision say what the sentence cites it for?" is a reading, not
 * a piece of writing: the answer space is three findings and one passage, so
 * it goes to the decision model rather than a generative one. One request
 * carries both questions, because the relation and the passage it rests on
 * are one judgment and asking twice would let them disagree.
 *
 * The model chooses; it does not quote. The passage that comes back is the
 * one the request offered, verbatim, which is what makes it citable.
 */

import {
  CITATION_RELATION_CRITERIA,
  NO_PASSAGE_CRITERION,
  readCitationRelation,
} from "@/api/handlers/case-law/citations/check.logic";
import type { OrgAIConfig } from "@/api/lib/ai-config";
import { sourceChoiceCriteria } from "@/api/lib/workflow/decisions/answer-questions";
import type { AnswerSource } from "@/api/lib/workflow/decisions/answer-questions";
import { decideWithoutRecovery } from "@/api/lib/workflow/decisions/decide";
import type { DecisionModel } from "@/api/lib/workflow/decisions/decision-model";
import type { DecisionUsageMetering } from "@/api/lib/workflow/decisions/decision-usage";
import {
  choice,
  SYSTEM_ONE_MAX_CHOICE_OPTIONS,
} from "@/api/lib/workflow/decisions/system-one";

/** Stable decision name, for the decision log line and later replay. */
const CITATION_CHECK_DECISION_ID = "case-law.citation-check";

/** One reading; the transport already retries the statuses worth retrying. */
const REQUEST_TIMEOUT_MS = 15_000;

/** The one question the vocabulary is fixed for; the criteria never vary. */
const RELATION_QUESTION = choice(
  {
    task: "How does the decision in `decision` stand to the statement in `claim`?",
    judge:
      "Judge the court's own holding and reasoning in `passages`. What a party submitted, or what a lower court held and this decision merely recounts, is not this court's position.",
    language_note:
      "`claim` may be written in a language other than the decision's. Judge what it asserts, not how it is worded.",
  },
  CITATION_RELATION_CRITERIA,
);

export type CheckCitationDecisionOptions = {
  orgAIConfig: OrgAIConfig | null;
  /** The sentence the decision was cited for, in whatever language it is written. */
  claim: string;
  /** The claim's language when the caller knows it; the decision's otherwise. */
  claimLanguage: string;
  decision: {
    caseNumber: string;
    court: string;
    country: string;
    decisionDate: string | null;
    language: string;
  };
  /** The decision's passages, in reading order or ranked against the claim. */
  sources: readonly AnswerSource[];
  usageMetering?: DecisionUsageMetering | undefined;
  /** Injected by tests; the organization's resolved model otherwise. */
  client?: DecisionModel | null | undefined;
};

export const checkCitationDecision = async ({
  claim,
  claimLanguage,
  client,
  decision,
  orgAIConfig,
  sources,
  usageMetering,
}: CheckCitationDecisionOptions) => {
  // The where-question offers one option per passage plus `__none`, so a
  // decision cut into more passages than a question may offer is judged
  // without naming the passage.
  const where =
    sources.length < SYSTEM_ONE_MAX_CHOICE_OPTIONS
      ? choice(
          {
            claim,
            task: "Which entry of `passages` carries the treatment you chose for `relation`? Choose `__none` when no single passage does.",
          },
          sourceChoiceCriteria(sources, NO_PASSAGE_CRITERION),
        )
      : null;
  const state = {
    claim,
    claimLanguage,
    decision: {
      caseNumber: decision.caseNumber,
      court: decision.court,
      country: decision.country,
      decisionDate: decision.decisionDate ?? "unknown",
      language: decision.language,
    },
    passages: sources.map((source) => ({ id: source.id, text: source.text })),
  };
  const shared = {
    id: CITATION_CHECK_DECISION_ID,
    orgAIConfig,
    // The claim is the member's own prose.
    dataClass: "customer",
    state,
    timeoutMs: REQUEST_TIMEOUT_MS,
    client,
    usageMetering,
  } as const;
  if (where === null) {
    const { decisions, model } = await decideWithoutRecovery({
      ...shared,
      questions: { relation: RELATION_QUESTION },
    });
    return {
      model,
      result: readCitationRelation({
        relation: decisions.relation,
        where: null,
        sources,
      }),
    };
  }
  const { decisions, model } = await decideWithoutRecovery({
    ...shared,
    questions: { relation: RELATION_QUESTION, where },
  });
  return {
    model,
    result: readCitationRelation({
      relation: decisions.relation,
      where: decisions.where,
      sources,
    }),
  };
};
