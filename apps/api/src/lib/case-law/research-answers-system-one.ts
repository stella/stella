/**
 * The typed-judgment tier of the question-column runner, as pure decisions.
 *
 * A question column whose answer space is closed (a select, a date, an
 * integer) is a selection, not a generation, so it goes to a System One model
 * that judges rather than writes. This module holds everything that decision
 * needs and nothing that touches a network or a database: which questions the
 * tier may take, how much of a decision's text fits its state, and what each
 * answer means for the cell. The runner owns the call itself.
 *
 * Nothing here fails a cell that the generative model could still answer: a
 * question the kit could not plan, a decision that was not taken, and a value
 * that no longer matches the column all come back as a fallback, and the run
 * asks the generative model for those columns instead.
 */

import { Result } from "better-result";

import type { FieldContent } from "@/api/db/schema-validators";
import {
  buildAnswerJustification,
  selectPassagesWithinBudget,
} from "@/api/lib/case-law/research-answers";
import type {
  CaseLawResearchAnswerRun,
  ResearchAnswerFailureReason,
  ResearchPassage,
  ResearchQuestion,
} from "@/api/lib/case-law/research-answers";
import { LIMITS } from "@/api/lib/limits";
import {
  fieldContentFromValidated,
  validateAnswerForContent,
} from "@/api/lib/workflow/ai-validators";
import {
  isSystemOneAnswerable,
  SYSTEM_ONE_SOURCE_BUDGET_CHARS,
} from "@/api/lib/workflow/decisions/answer-questions";
import type {
  AnswerOutcome,
  AnswerQuestion,
  AnswerSource,
} from "@/api/lib/workflow/decisions/answer-questions";

export type SystemOneQuestionSplit<TQuestion extends ResearchQuestion> = {
  /** The tier's questions, each id the column it answers. */
  asked: AnswerQuestion[];
  /** Columns the tier cannot take: text has no closed answer space. */
  generative: TQuestion[];
};

export const splitSystemOneQuestions = <TQuestion extends ResearchQuestion>(
  questions: readonly TQuestion[],
): SystemOneQuestionSplit<TQuestion> => {
  const asked: AnswerQuestion[] = [];
  const generative: TQuestion[] = [];
  for (const question of questions) {
    const { columnId, content } = question;
    if (isSystemOneAnswerable(content)) {
      asked.push({ id: columnId, question: question.question, content });
      continue;
    }
    generative.push(question);
  }
  return { asked, generative };
};

const excerptChars = (passages: readonly ResearchPassage[]): number =>
  passages.reduce((sum, passage) => sum + passage.excerpt.length, 0);

/**
 * Whether the text resolved for the generative prompt is longer than the state
 * Jev reads. Over it the caller ranks the passages by the questions before
 * spending the budget, because reading order would spend all of it on the
 * decision's opening.
 */
export const exceedsSystemOneSourceBudget = (
  passages: readonly ResearchPassage[],
): boolean => excerptChars(passages) > SYSTEM_ONE_SOURCE_BUDGET_CHARS;

/**
 * The passages as sources, in the order given, cut to the state budget. The
 * budget is the only cap: a source is what the model picks a verbatim date or
 * amount out of, so a long passage is kept as far as it fits rather than
 * shortened to a passage-sized excerpt that would hide the values asked about.
 */
export const systemOneSourcesFromPassages = (
  passages: readonly ResearchPassage[],
): AnswerSource[] =>
  selectPassagesWithinBudget(passages, {
    budgetChars: SYSTEM_ONE_SOURCE_BUDGET_CHARS,
    passageChars: SYSTEM_ONE_SOURCE_BUDGET_CHARS,
  }).map((passage) => ({ id: passage.anchorId, text: passage.excerpt }));

type SystemOneResearchOutcome =
  | { state: "answered"; answer: FieldContent; run: CaseLawResearchAnswerRun }
  | {
      state: "failed";
      failureReason: Extract<ResearchAnswerFailureReason, "not_stated">;
    };

type SystemOneColumnOutcome = {
  columnId: string;
  outcome: SystemOneResearchOutcome;
};

export type SystemOneResolution = {
  /** Cells the tier settled: an answer, or the kind's own "not stated". */
  settled: SystemOneColumnOutcome[];
  /** Columns the generative model has to answer after all. */
  fallbackColumnIds: string[];
};

type SystemOneRunFacts = Pick<
  CaseLawResearchAnswerRun,
  "completedAt" | "model" | "retrieved"
>;

type ResolveSystemOneOutcomesOptions = {
  questions: readonly AnswerQuestion[];
  /** One outcome per question the kit planned and the model answered. */
  outcomes: ReadonlyMap<string, AnswerOutcome>;
  /** The text behind each source id, for the justification blocks. */
  excerptByAnchor: ReadonlyMap<string, string>;
  run: SystemOneRunFacts;
};

/**
 * One cell decision per question: written, said to be unstated, or handed on.
 * An answer becomes `FieldContent` through the same validators the generative
 * parser uses, so a select or a date that is not stated writes an answered
 * null cell while an int reports why it is empty.
 */
export const resolveSystemOneOutcomes = ({
  excerptByAnchor,
  outcomes,
  questions,
  run,
}: ResolveSystemOneOutcomesOptions): SystemOneResolution => {
  const settled: SystemOneColumnOutcome[] = [];
  const fallbackColumnIds: string[] = [];
  for (const question of questions) {
    const outcome = outcomes.get(question.id);
    // No outcome means the kit could not plan the question (a select with no
    // options, a date the text spells nowhere); undecided means no decision
    // model, an answer under the floor, or a failed call.
    if (outcome === undefined || outcome.state === "undecided") {
      fallbackColumnIds.push(question.id);
      continue;
    }
    const validated = validateAnswerForContent({
      answer: outcome.state === "answered" ? outcome.answer : null,
      content: question.content,
    });
    // A chosen value comes from this column's own options or from a candidate
    // read out of its sources, so a validation error means the two drifted
    // apart mid-run: ask the generative model rather than write the cell wrong.
    if (Result.isError(validated)) {
      fallbackColumnIds.push(question.id);
      continue;
    }
    const answer = fieldContentFromValidated(validated.value);
    if (answer === null) {
      settled.push({
        columnId: question.id,
        outcome: { state: "failed", failureReason: "not_stated" },
      });
      continue;
    }
    const sourceId = outcome.state === "answered" ? outcome.sourceId : null;
    settled.push({
      columnId: question.id,
      outcome: {
        state: "answered",
        answer,
        run: {
          version: 1,
          model: run.model,
          completedAt: run.completedAt,
          retrieved: run.retrieved,
          rationale: outcome.rationale.slice(
            0,
            LIMITS.caseLawResearchAnswerRationaleChars,
          ),
          justification: buildAnswerJustification(
            sourceId === null ? [] : [sourceId],
            excerptByAnchor,
          ),
        },
      },
    });
  }
  return { settled, fallbackColumnIds };
};
