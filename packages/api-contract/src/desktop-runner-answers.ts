import * as v from "valibot";

/**
 * What one `run.answer` may carry. A run asks a blocking question as a chunk
 * whose `RUN_FINISHED` interrupt has `metadata.kind: "question"`; the answers
 * name each question by its id. Lengths are UTF-16 code units, as JavaScript
 * counts them.
 */
export const DESKTOP_RUNNER_ANSWER_LIMITS = {
  maxQuestions: 32,
  maxAnswersPerQuestion: 64,
  maxAnswerLength: 16_384,
  maxQuestionIdLength: 256,
} as const;

/** The keys `v.record` leaves out of what it parses, without an issue. */
const RECORD_DROPPED_KEYS: ReadonlySet<string> = new Set([
  "__proto__",
  "prototype",
  "constructor",
]);

/**
 * The id a blocking question names one of its questions by, in the pause
 * that asks it and in the answers alike. Answers are a record keyed by this
 * id, so an id the record would drop could never be answered.
 */
export const desktopRunnerQuestionIdSchema = v.pipe(
  v.string(),
  v.minLength(1),
  v.maxLength(DESKTOP_RUNNER_ANSWER_LIMITS.maxQuestionIdLength),
  v.check(
    (id) => !RECORD_DROPPED_KEYS.has(id),
    "A question id must survive as an answer key",
  ),
);

/**
 * Answers to a blocking question, keyed by question id: option labels or
 * free text. A question may be answered by several options.
 */
export const desktopRunnerQuestionAnswersSchema = v.pipe(
  v.record(
    desktopRunnerQuestionIdSchema,
    v.pipe(
      v.array(
        v.pipe(
          v.string(),
          v.maxLength(DESKTOP_RUNNER_ANSWER_LIMITS.maxAnswerLength),
        ),
      ),
      v.maxLength(DESKTOP_RUNNER_ANSWER_LIMITS.maxAnswersPerQuestion),
    ),
  ),
  v.check(
    (answers) =>
      Object.keys(answers).length <= DESKTOP_RUNNER_ANSWER_LIMITS.maxQuestions,
    `At most ${String(DESKTOP_RUNNER_ANSWER_LIMITS.maxQuestions)} questions are answered at once`,
  ),
);
export type DesktopRunnerQuestionAnswers = v.InferOutput<
  typeof desktopRunnerQuestionAnswersSchema
>;
