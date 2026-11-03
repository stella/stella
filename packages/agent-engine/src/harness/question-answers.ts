import * as v from "valibot";

import type { HarnessQuestion } from "./events";

/**
 * A blocking question as its chunk's interrupt carries it
 * (`metadata.questions`), for a reader on the other side of the runner
 * socket. It parses to exactly a `HarnessQuestion`.
 */
export const harnessQuestionSchema = v.object({
  id: v.string(),
  header: v.string(),
  prompt: v.string(),
  options: v.array(v.object({ label: v.string(), description: v.string() })),
  allowsFreeText: v.boolean(),
  secret: v.boolean(),
});

type Same<TLeft, TRight> = [TLeft] extends [TRight]
  ? [TRight] extends [TLeft]
    ? true
    : false
  : false;
true satisfies Same<
  v.InferOutput<typeof harnessQuestionSchema>,
  { -readonly [K in keyof HarnessQuestion]: HarnessQuestion[K] } & {
    options: { label: string; description: string }[];
  }
>;

/**
 * Why `answers` do not answer `questions`, or `null` when they do. Every
 * question takes at least one answer, a question without free text takes
 * only its option labels (the label is the native reply), and only the
 * questions asked are answered. Every harness applies this one rule, and the
 * API applies it before an answer leaves for the computer, so an answer the
 * harness would refuse never leaves its run waiting.
 */
export const questionAnswersRefusal = (
  questions: readonly HarnessQuestion[],
  answers: Readonly<Record<string, readonly string[]>>,
): string | null => {
  const asked = new Set(questions.map(({ id }) => id));
  const unasked = Object.keys(answers).find((id) => !asked.has(id));
  if (unasked !== undefined) {
    return `Question ${unasked} was not asked.`;
  }
  for (const question of questions) {
    const given = answers[question.id] ?? [];
    if (given.length === 0) {
      return `Question ${question.id} has no answer.`;
    }
    const labels = new Set(question.options.map(({ label }) => label));
    if (!question.allowsFreeText && given.some((a) => !labels.has(a))) {
      return `Question ${question.id} takes one of its options.`;
    }
  }
  return null;
};
