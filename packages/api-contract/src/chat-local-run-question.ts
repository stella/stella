import * as v from "valibot";

import {
  chatLocalRunAnswersRefusal,
  type ChatLocalRunQuestion,
  chatLocalRunQuestionReplySchema,
  chatLocalRunQuestionsSchema,
} from "./chat-run-target";

/**
 * A local run paused on a blocking question: the interrupt an answer resumes
 * and the questions it asks. The harness asks one question request at a time,
 * so a paused turn holds at most one.
 */
export type LocalRunQuestionPause = {
  interruptId: string;
  questions: readonly ChatLocalRunQuestion[];
};

/**
 * The interrupt fields a pause is read from, as TanStack's state and a stored
 * turn's resume snapshot both have them.
 */
type InterruptView = {
  readonly id: string;
  readonly reason: string;
  readonly metadata?: Readonly<Record<string, unknown>> | undefined;
};

/**
 * The question a turn is paused on, read from its pending interrupts: a
 * `user_input` interrupt whose `metadata.kind` is `question`. The stream and a
 * reloaded resume snapshot carry the same descriptor, so a live pause and a
 * reloaded one read alike, in the browser and on the phone. Questions that do not parse are not shown: a
 * card could only offer answers the server refuses.
 */
export const localRunQuestionPauseOf = (
  interrupts: readonly InterruptView[],
): LocalRunQuestionPause | null => {
  for (const interrupt of interrupts) {
    if (
      interrupt.reason !== "user_input" ||
      interrupt.metadata?.["kind"] !== "question"
    ) {
      continue;
    }
    const questions = v.safeParse(
      chatLocalRunQuestionsSchema,
      interrupt.metadata["questions"],
    );
    if (questions.success) {
      return { interruptId: interrupt.id, questions: questions.output };
    }
  }
  return null;
};

/** Whether two reads name the same pause, so the shown one can be kept. */
export const isSameLocalRunQuestionPause = (
  left: LocalRunQuestionPause | null,
  right: LocalRunQuestionPause | null,
): boolean => left?.interruptId === right?.interruptId;

/**
 * What the member has entered for one question: the options picked, and their
 * own words, which stand in for the options while `ownWords` is on (or when
 * the question has no options).
 */
export type LocalRunQuestionDraft = {
  picked: readonly string[];
  text: string;
  ownWords: boolean;
};

export const EMPTY_LOCAL_RUN_QUESTION_DRAFT: LocalRunQuestionDraft =
  Object.freeze({ picked: Object.freeze([]), text: "", ownWords: false });

/** Whether the question takes the member's own words instead of options. */
export const answersInOwnWords = (
  question: ChatLocalRunQuestion,
  draft: LocalRunQuestionDraft,
): boolean =>
  question.options.length === 0 || (question.allowsFreeText && draft.ownWords);

/** Pick an option, or drop it again: one of a single choice, any of several. */
export const toggleLocalRunOption = (
  question: ChatLocalRunQuestion,
  draft: LocalRunQuestionDraft,
  label: string,
): LocalRunQuestionDraft => {
  if (draft.picked.includes(label)) {
    return {
      ...draft,
      picked: draft.picked.filter((picked) => picked !== label),
    };
  }
  return {
    ...draft,
    picked: question.multiSelect ? [...draft.picked, label] : [label],
  };
};

/**
 * The answer one draft gives. Own words are trimmed, except a secret's, which
 * is sent as typed; blank words are no answer.
 */
export const localRunAnswerOf = (
  question: ChatLocalRunQuestion,
  draft: LocalRunQuestionDraft,
): string[] => {
  if (!answersInOwnWords(question, draft)) {
    return [...draft.picked];
  }
  const words = question.secret ? draft.text : draft.text.trim();
  return words.trim() === "" ? [] : [words];
};

/** The answers the drafts give, keyed by question id as the resume payload carries them. */
export const localRunAnswersOf = (
  questions: readonly ChatLocalRunQuestion[],
  drafts: Readonly<Record<string, LocalRunQuestionDraft>>,
): Record<string, string[]> =>
  Object.fromEntries(
    questions.map((question) => [
      question.id,
      localRunAnswerOf(
        question,
        Object.hasOwn(drafts, question.id)
          ? (drafts[question.id] ?? EMPTY_LOCAL_RUN_QUESTION_DRAFT)
          : EMPTY_LOCAL_RUN_QUESTION_DRAFT,
      ),
    ]),
  );

/**
 * Whether the drafts answer every question the way the server accepts: the
 * one rule the API and the harness apply, so Submit is offered only for an
 * answer that continues the run.
 */
export const canSubmitLocalRunAnswers = (
  questions: readonly ChatLocalRunQuestion[],
  drafts: Readonly<Record<string, LocalRunQuestionDraft>>,
): boolean => {
  const answers = localRunAnswersOf(questions, drafts);
  return (
    v.is(chatLocalRunQuestionReplySchema, { answers }) &&
    chatLocalRunAnswersRefusal(questions, answers) === null
  );
};
