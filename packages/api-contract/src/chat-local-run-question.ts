import * as v from "valibot";

import {
  DESKTOP_RUNNER_ANSWER_LIMITS,
  desktopRunnerQuestionAnswersSchema,
  desktopRunnerQuestionIdSchema,
} from "./desktop-runner-answers";

// A leaf: it imports nothing of the runner protocol, so the phone can ask and
// check a local run's question without loading it.

/**
 * The resume payload that answers a local run's blocking question: the
 * interrupt the question paused the turn with (`metadata.kind: "question"`,
 * its questions in `metadata.questions`) is resumed with `status: "resolved"`
 * and this payload. Answers are keyed by question id and hold option labels
 * or free text; every question asked takes at least one, and a question
 * without free text takes only its option labels. A `cancelled` resume
 * stops the run's turn instead of answering.
 */
export const chatLocalRunQuestionReplySchema = v.strictObject({
  answers: desktopRunnerQuestionAnswersSchema,
});
export type ChatLocalRunQuestionReply = v.InferOutput<
  typeof chatLocalRunQuestionReplySchema
>;

/**
 * The tool call a local run's question is persisted as, for every harness:
 * Codex's native item name, which a Claude Code `AskUserQuestion` takes too.
 */
export const CHAT_LOCAL_RUN_QUESTION_TOOL = "request_user_input";

/**
 * One question of a local run's blocking question, as its interrupt carries
 * it (`metadata.questions`). An answer names an option by its `label`, which
 * is the harness's native reply. `multiSelect` lets one answer pick several
 * options; `allowsFreeText` lets it be the member's own words; a `secret`
 * answer is never shown back.
 */
export const chatLocalRunQuestionSchema = v.object({
  id: desktopRunnerQuestionIdSchema,
  header: v.string(),
  prompt: v.string(),
  options: v.array(v.object({ label: v.string(), description: v.string() })),
  allowsFreeText: v.boolean(),
  multiSelect: v.boolean(),
  secret: v.boolean(),
});
/**
 * The questions one blocking question asks: at least one, each under its own
 * id, and no more than one answer may carry
 * (`DESKTOP_RUNNER_ANSWER_LIMITS`), so every pause can be answered.
 */
export const chatLocalRunQuestionsSchema = v.pipe(
  v.array(chatLocalRunQuestionSchema),
  v.minLength(1),
  v.maxLength(DESKTOP_RUNNER_ANSWER_LIMITS.maxQuestions),
  v.check(
    (questions) =>
      new Set(questions.map(({ id }) => id)).size === questions.length,
    "Each question has its own id",
  ),
  v.check(
    (questions) =>
      questions.every(
        ({ allowsFreeText, options }) => allowsFreeText || options.length > 0,
      ),
    "Each question offers an option or free text",
  ),
);
export type ChatLocalRunQuestion = Readonly<
  Omit<v.InferOutput<typeof chatLocalRunQuestionSchema>, "options">
> & {
  readonly options: readonly { label: string; description: string }[];
};

/**
 * Why `answers` do not answer `questions`, or `null` when they do. Every
 * question takes at least one answer, a single-choice question takes only one,
 * a question without free text takes only its option labels, and only the
 * questions asked are answered. The browser checks it before sending, the API
 * before an answer leaves for the computer, and every harness before replying,
 * so an answer the harness would refuse never leaves its run waiting.
 */
export const chatLocalRunAnswersRefusal = (
  questions: readonly ChatLocalRunQuestion[],
  answers: Readonly<Record<string, readonly string[]>>,
): string | null => {
  const asked = new Set(questions.map(({ id }) => id));
  const unasked = Object.keys(answers).find((id) => !asked.has(id));
  if (unasked !== undefined) {
    return `Question ${unasked} was not asked.`;
  }
  for (const question of questions) {
    const given = Object.hasOwn(answers, question.id)
      ? (answers[question.id] ?? [])
      : [];
    if (given.length === 0) {
      return `Question ${question.id} has no answer.`;
    }
    if (!question.multiSelect && given.length > 1) {
      return `Question ${question.id} takes one answer.`;
    }
    const labels = new Set(question.options.map(({ label }) => label));
    if (!question.allowsFreeText && given.some((a) => !labels.has(a))) {
      return `Question ${question.id} takes one of its options.`;
    }
  }
  return null;
};

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
