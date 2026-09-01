import * as v from "valibot";

import {
  CASE_LAW_RESEARCH_ANSWER_TYPES,
  CASE_LAW_RESEARCH_QUESTION_MAX_LENGTH,
  CASE_LAW_RESEARCH_YES_NO_VALUES,
} from "@stll/api-contract";
import type {
  CaseLawResearchAnswerPassage,
  CaseLawResearchAnswerType,
  CaseLawResearchAnswerValue,
  CaseLawResearchColumnTool,
} from "@stll/api-contract";

import { LIMITS } from "@/api/lib/limits";

/** The model configuration new columns are created with. */
export const caseLawResearchColumnToolSchema = v.strictObject({
  version: v.literal(1),
  role: v.literal("fast"),
});

export const defaultResearchColumnTool = (): CaseLawResearchColumnTool => ({
  version: 1,
  role: "fast",
});

/** Why a cell ended `failed`; a class, never the provider's wording. */
export const RESEARCH_ANSWER_FAILURE_REASONS = [
  "decision_unavailable",
  "no_text",
  "ai_unavailable",
  "model_error",
  "missing_answer",
  "wrong_type",
] as const;

export type ResearchAnswerFailureReason =
  (typeof RESEARCH_ANSWER_FAILURE_REASONS)[number];

export type ResearchQuestion = {
  columnId: string;
  question: string;
  answerType: CaseLawResearchAnswerType;
};

export type ResearchPassage = CaseLawResearchAnswerPassage;

type SelectPassagesOptions = {
  /** Total characters of excerpt the selection may hold. */
  budgetChars: number;
  /** Longest excerpt one passage may contribute. */
  passageChars: number;
};

/**
 * Keep passages in the order given, one per anchor, each cut to the passage
 * cap, until the budget is spent. Order is the caller's ranking, so the best
 * passages survive when the budget is short.
 */
export const selectPassagesWithinBudget = (
  passages: readonly ResearchPassage[],
  { budgetChars, passageChars }: SelectPassagesOptions,
): ResearchPassage[] => {
  const selected: ResearchPassage[] = [];
  const seen = new Set<string>();
  let used = 0;
  for (const passage of passages) {
    const excerpt = passage.excerpt.trim().slice(0, passageChars);
    if (
      excerpt.length === 0 ||
      passage.anchorId.length === 0 ||
      seen.has(passage.anchorId)
    ) {
      continue;
    }
    if (used + excerpt.length > budgetChars) {
      break;
    }
    seen.add(passage.anchorId);
    used += excerpt.length;
    selected.push({ anchorId: passage.anchorId, excerpt });
  }
  return selected;
};

export const RESEARCH_SYSTEM_PROMPT = `You answer a lawyer's questions about one court decision, from its text alone.
Answer every question listed, by its column id. A yes/no question takes "yes", "no" or "unclear" when the text does not settle it; never guess.
A text question takes a short answer in the language of the question.
Cite the passage anchors (the bracketed ids in the text) you relied on, and give a one-sentence rationale.
Do not use knowledge outside the text.`;

type BuildResearchUserMessageOptions = {
  decision: {
    caseNumber: string;
    court: string;
    country: string;
    language: string;
    decisionType: string | null;
  };
  questions: readonly ResearchQuestion[];
  /** Anchored passages of the decision, in reading or ranking order. */
  passages: readonly ResearchPassage[];
  /** Whether the passages are a retrieved subset rather than the whole text. */
  retrieved: boolean;
};

export const buildResearchUserMessage = ({
  decision,
  passages,
  questions,
  retrieved,
}: BuildResearchUserMessageOptions): string => {
  const header = [
    `Case: ${decision.caseNumber}`,
    `Court: ${decision.court} (${decision.country})`,
    `Type: ${decision.decisionType ?? "unknown"}`,
    `Language of the text: ${decision.language}`,
    retrieved
      ? "The passages below are the parts of the decision most relevant to the questions; the rest was not sent."
      : "The full text of the decision follows.",
  ].join("\n");
  const text = passages
    .map((passage) => `[${passage.anchorId}] ${passage.excerpt}`)
    .join("\n\n");
  const asked = questions
    .map(
      (question) =>
        `- ${question.columnId} (${question.answerType === "yes_no" ? "yes/no" : "text"}): ${question.question}`,
    )
    .join("\n");
  return `${header}\n\n${text}\n\nQuestions:\n${asked}`;
};

/** What the model returns for a batch of questions on one decision. */
export const researchAnswersOutputSchema = v.strictObject({
  answers: v.array(
    v.strictObject({
      columnId: v.string(),
      yesNo: v.optional(v.picklist(CASE_LAW_RESEARCH_YES_NO_VALUES)),
      text: v.optional(v.string()),
      confidence: v.pipe(v.number(), v.minValue(0), v.maxValue(1)),
      rationale: v.string(),
      anchorIds: v.array(v.string()),
    }),
  ),
});

export type ResearchAnswersOutput = v.InferOutput<
  typeof researchAnswersOutputSchema
>;

export type ParsedResearchAnswer = {
  columnId: string;
  outcome:
    | {
        state: "answered";
        answer: CaseLawResearchAnswerValue;
        confidence: number;
        rationale: string;
        anchorIds: string[];
      }
    | {
        state: "failed";
        failureReason: Extract<
          ResearchAnswerFailureReason,
          "missing_answer" | "wrong_type"
        >;
      };
};

type ParseResearchAnswersOptions = {
  output: ResearchAnswersOutput;
  questions: readonly ResearchQuestion[];
  /** Anchors that were actually sent; anything else the model cites is dropped. */
  knownAnchorIds: ReadonlySet<string>;
};

/**
 * One outcome per question, whatever the model returned: a question the model
 * skipped or answered in the wrong shape fails by name instead of vanishing.
 * The first answer for a column wins; anchors are kept only when they were in
 * the prompt, and in prompt order.
 */
export const parseResearchAnswers = ({
  knownAnchorIds,
  output,
  questions,
}: ParseResearchAnswersOptions): ParsedResearchAnswer[] => {
  const firstByColumn = new Map<
    string,
    ResearchAnswersOutput["answers"][number]
  >();
  for (const answer of output.answers) {
    if (!firstByColumn.has(answer.columnId)) {
      firstByColumn.set(answer.columnId, answer);
    }
  }
  const anchorOrder = [...knownAnchorIds];

  return questions.map((question) => {
    const answer = firstByColumn.get(question.columnId);
    if (answer === undefined) {
      return {
        columnId: question.columnId,
        outcome: { state: "failed", failureReason: "missing_answer" },
      };
    }
    const value = answerValueFor(question.answerType, answer);
    if (value === null) {
      return {
        columnId: question.columnId,
        outcome: { state: "failed", failureReason: "wrong_type" },
      };
    }
    const cited = new Set(answer.anchorIds);
    return {
      columnId: question.columnId,
      outcome: {
        state: "answered",
        answer: value,
        confidence: answer.confidence,
        rationale: answer.rationale
          .trim()
          .slice(0, LIMITS.caseLawResearchAnswerRationaleChars),
        anchorIds: anchorOrder.filter((anchorId) => cited.has(anchorId)),
      },
    };
  });
};

const answerValueFor = (
  answerType: CaseLawResearchAnswerType,
  answer: ResearchAnswersOutput["answers"][number],
): CaseLawResearchAnswerValue | null => {
  switch (answerType) {
    case "yes_no":
      return answer.yesNo === undefined
        ? null
        : { type: "yes_no", value: answer.yesNo };
    case "text": {
      const text = answer.text?.trim() ?? "";
      return text.length === 0 ? null : { type: "text", value: text };
    }
    default: {
      const exhaustive: never = answerType;
      return exhaustive;
    }
  }
};

/** A question as the route accepts it; the handler re-parses. */
export const researchQuestionSchema = v.pipe(
  v.string(),
  v.trim(),
  v.minLength(1),
  v.maxLength(CASE_LAW_RESEARCH_QUESTION_MAX_LENGTH),
);

export const isResearchAnswerType = (
  value: string,
): value is CaseLawResearchAnswerType =>
  CASE_LAW_RESEARCH_ANSWER_TYPES.some((type) => type === value);
