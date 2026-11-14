import * as v from "valibot";

export const ASK_USER_SELECTION = {
  single: "single",
  multiple: "multiple",
} as const;

export type AskUserSelection =
  (typeof ASK_USER_SELECTION)[keyof typeof ASK_USER_SELECTION];

export const askUserQuestionSchema = v.strictObject({
  question: v.string(),
  reason: v.pipe(v.string(), v.description("Why this matters for the task")),
  options: v.optional(
    v.pipe(
      v.array(v.string()),
      // An answer names the options it ticks, so two equal labels could not
      // be told apart.
      v.check(
        (options) => new Set(options).size === options.length,
        "Each option must be different.",
      ),
      v.description(
        "Suggested options (A/B/C style). The user can also write their " +
          "own answer.",
      ),
    ),
  ),
  selection: v.optional(
    v.pipe(
      v.picklist(Object.values(ASK_USER_SELECTION)),
      v.description(
        `"${ASK_USER_SELECTION.multiple}" when the user may pick more than ` +
          "one option; the answer lists the ticked ones in `selected`. The " +
          'card offers Select all, so add no "all of the above" option.',
      ),
    ),
  ),
  default: v.optional(
    v.pipe(v.string(), v.description("Preselected option or default value")),
  ),
});

export type AskUserQuestion = v.InferOutput<typeof askUserQuestionSchema>;

/**
 * One answer per question, in question order. `selected` holds the options
 * ticked on a multiple-choice question; `answer` holds the one option picked
 * on a single-choice question, or the user's own words on either kind.
 */
export const askUserAnswerSchema = v.union([
  v.strictObject({ question: v.string(), answer: v.string() }),
  v.strictObject({
    question: v.string(),
    selected: v.pipe(v.array(v.string()), v.minLength(1)),
  }),
]);

export type AskUserAnswer = v.InferOutput<typeof askUserAnswerSchema>;

export const askUserInputSchema = v.strictObject({
  analysis: v.pipe(
    v.string(),
    v.description(
      "Brief analysis of the task and what you already know from context",
    ),
  ),
  questions: v.pipe(
    v.array(askUserQuestionSchema),
    v.minLength(1),
    v.maxLength(10),
    v.description("Clarifying questions to ask"),
  ),
});

export const askUserOutputSchema = v.strictObject({
  answers: v.array(askUserAnswerSchema),
});

export const askUserSelectionOf = (
  question: AskUserQuestion,
): AskUserSelection => question.selection ?? ASK_USER_SELECTION.single;

/** The values an answer carries: the ticked options, or its one answer. */
export const askUserAnswerValues = (
  answer: AskUserAnswer,
): readonly string[] =>
  "selected" in answer ? answer.selected : [answer.answer];

/**
 * Why `answers` cannot answer `questions`, or `null`. There is one answer per
 * question, in order. Ticked options must be options of a multiple-choice
 * question, each once: this list can decide which documents the model may
 * read, so it has to be exact. A typed `answer` is the user's own words.
 */
export const askUserAnswersRefusal = (
  questions: readonly AskUserQuestion[],
  answers: readonly AskUserAnswer[],
): string | null => {
  if (answers.length !== questions.length) {
    return `Expected ${String(questions.length)} answers, got ${String(answers.length)}.`;
  }
  for (const [index, question] of questions.entries()) {
    const answer = answers.at(index);
    if (answer?.question !== question.question) {
      return `Answer ${String(index + 1)} is for a different question.`;
    }
    if (!("selected" in answer)) {
      continue;
    }
    if (askUserSelectionOf(question) !== ASK_USER_SELECTION.multiple) {
      return `Question ${String(index + 1)} takes one answer, not a selection.`;
    }
    const options = new Set(question.options);
    if (answer.selected.some((value) => !options.has(value))) {
      return `Question ${String(index + 1)} was answered with a value that is not one of its options.`;
    }
    if (new Set(answer.selected).size !== answer.selected.length) {
      return `Question ${String(index + 1)} was answered with the same option twice.`;
    }
  }
  return null;
};
