/**
 * The typed judgment behind a citation check.
 *
 * "Does this decision say what the sentence cites it for?" is a reading, not
 * a piece of writing: the answer space is three findings and one passage, so
 * it goes to a System One model rather than a generative one. One request
 * carries both questions, because the relation and the passage it rests on
 * are one judgment and asking twice would let them disagree.
 *
 * The model chooses; it does not quote. The passage that comes back is the
 * one the request offered, verbatim, which is what makes it citable.
 */

import { Result } from "better-result";

import {
  CITATION_RELATION_CRITERIA,
  NO_PASSAGE_CRITERION,
  readCitationRelation,
} from "@/api/handlers/case-law/citations/check.logic";
import type { CitationReading } from "@/api/handlers/case-law/citations/check.logic";
import { sourceChoiceCriteria } from "@/api/lib/typesafe/answer-questions";
import type { AnswerSource } from "@/api/lib/typesafe/answer-questions";
import { choice } from "@/api/lib/typesafe/system-one";
import type {
  SystemOneClient,
  SystemOneError,
} from "@/api/lib/typesafe/system-one";

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

export type CheckCitationWithSystemOneOptions = {
  client: SystemOneClient;
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
  /** The decision's passages, ranked against the claim, best first. */
  sources: readonly AnswerSource[];
  abortSignal?: AbortSignal | undefined;
};

export type SystemOneCitationCheck = CitationReading & {
  /** The versioned model that answered, as the response reports it. */
  model: string;
  latencyMs: number;
  inputTokens: number;
};

export const checkCitationWithSystemOne = async ({
  abortSignal,
  claim,
  claimLanguage,
  client,
  decision,
  sources,
}: CheckCitationWithSystemOneOptions): Promise<
  Result<SystemOneCitationCheck, SystemOneError>
> => {
  const asked = await client.ask({
    state: {
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
    },
    questions: {
      relation: RELATION_QUESTION,
      where: choice(
        {
          claim,
          task: "Which entry of `passages` carries the treatment you chose for `relation`? Choose `__none` when no single passage does.",
        },
        sourceChoiceCriteria(sources, NO_PASSAGE_CRITERION),
      ),
    },
    abortSignal:
      abortSignal === undefined
        ? AbortSignal.timeout(REQUEST_TIMEOUT_MS)
        : AbortSignal.any([
            abortSignal,
            AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          ]),
  });
  if (Result.isError(asked)) {
    return asked;
  }
  const { answers, latencyMs, model, usage } = asked.value;
  return Result.ok({
    ...readCitationRelation({
      relation: answers.relation,
      where: answers.where.choice,
      sources,
    }),
    model,
    latencyMs,
    inputTokens: usage.inputTokens,
  });
};
