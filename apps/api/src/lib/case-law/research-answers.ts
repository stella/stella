import { Value } from "@sinclair/typebox/value";
import { panic, Result } from "better-result";
import * as v from "valibot";

import { CASE_LAW_RESEARCH_QUESTION_MAX_LENGTH } from "@stll/api-contract";
import type {
  CaseLawResearchAnswerFailureReason,
  CaseLawResearchColumnTool,
} from "@stll/api-contract";

import type { JustificationContent } from "@/api/db/schema";
import { fieldContentSchema } from "@/api/db/schema-validators";
import type {
  AiExtractablePropertyContent,
  FieldContent,
} from "@/api/db/schema-validators";
import { captureError } from "@/api/lib/analytics/capture";
import { DatabaseError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import {
  answerSchemaForContent,
  answerShapeHint,
} from "@/api/lib/workflow/ai-answer-schema";
import type { Answer } from "@/api/lib/workflow/ai-answer-schema";
import {
  fieldContentFromValidated,
  validateAnswerForContent,
} from "@/api/lib/workflow/ai-validators";
import type { ValidatedAnswer } from "@/api/lib/workflow/ai-validators";

/**
 * What a question column asks for, and what a cell holds.
 *
 * A question column is a matter property asked of a decision: it carries the
 * same content the property does (kind, select options, fallback), its answer
 * is the same `FieldContent` a workspace field holds, and its provenance is the
 * same justification shape — so one cell renderer and one output registry serve
 * both surfaces.
 */
export type CaseLawResearchColumnContent = AiExtractablePropertyContent;

export const defaultResearchColumnTool = (): CaseLawResearchColumnTool => ({
  version: 1,
  role: "fast",
});

export type ResearchQuestion = {
  columnId: string;
  question: string;
  content: CaseLawResearchColumnContent;
};

/** One anchored passage of a decision, as sent to the model. */
export type ResearchPassage = {
  anchorId: string;
  excerpt: string;
};

/** How an answer was produced; kept beside it so a cell can be audited. */
export type CaseLawResearchAnswerRun = {
  version: 1;
  model: string;
  completedAt: string;
  /** True when the decision was too long to send whole and passages were retrieved. */
  retrieved: boolean;
  rationale: string;
  /** The cited passages, in the citation shape a workspace justification uses. */
  justification: JustificationContent;
};

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
Return an object whose keys are exactly the column ids listed, each with the answer, a one-sentence rationale, and the passage anchors you relied on.
Each column's schema states the shape its answer takes; when the text does not state a value, answer null for that column rather than guessing.
Cite the passage anchors (the bracketed ids in the text) the answer rests on.
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
        `- ${question.columnId} (${answerShapeHint(question.content)}): ${question.question}`,
    )
    .join("\n");
  return `${header}\n\n${text}\n\nQuestions:\n${asked}`;
};

/** What the model returns for one question. */
export type ResearchAnswerOutput = {
  answer: Answer;
  rationale: string;
  anchorIds: string[];
};

/** Keyed by column id, like the extractor's batch is keyed by property id. */
type ResearchAnswersOutput = Record<string, ResearchAnswerOutput>;

/**
 * The batch a decision's pending questions are asked as: one entry per column,
 * its answer schema taken from the shared per-kind registry.
 *
 * A select column with no options is dropped rather than asked against an empty
 * list; the create/update boundary rejects one, so this is the same guard the
 * extractor applies to a property.
 */
export const buildResearchAnswersSchema = (
  questions: readonly ResearchQuestion[],
) => {
  const shape: Record<string, v.GenericSchema<ResearchAnswerOutput>> = {};
  for (const question of questions) {
    const answer = answerSchemaForContent(question.content);
    if (answer === null) {
      continue;
    }
    shape[question.columnId] = v.strictObject({
      answer,
      rationale: v.pipe(
        v.string(),
        v.description(
          "One sentence saying how the cited text answers the question.",
        ),
      ),
      anchorIds: v.pipe(
        v.array(v.string()),
        v.description(
          "The bracketed passage anchors the answer rests on, verbatim.",
        ),
      ),
    });
  }
  return v.strictObject(shape);
};

/**
 * A validated answer as a cell's content, or null when the decision does not
 * state it. Every kind has an empty value (a null, or an empty selection), and
 * each one means the same `not_stated` cell rather than an answer holding
 * nothing.
 */
export const statedAnswerContent = (
  validated: ValidatedAnswer,
): FieldContent | null => {
  switch (validated.type) {
    case "multi-select":
      return validated.value.length === 0
        ? null
        : fieldContentFromValidated(validated);
    case "text":
    case "single-select":
    case "date":
    case "int":
      return validated.value === null
        ? null
        : fieldContentFromValidated(validated);
    default: {
      validated satisfies never;
      return panic(`Unhandled answer kind: ${String(validated)}`);
    }
  }
};

export type ParsedResearchAnswer = {
  columnId: string;
  outcome:
    | {
        state: "answered";
        answer: FieldContent;
        rationale: string;
        anchorIds: string[];
      }
    | {
        state: "not_stated";
        rationale: string;
        anchorIds: string[];
      }
    | {
        state: "failed";
        failureReason: Extract<
          CaseLawResearchAnswerFailureReason,
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

/** Whitespace is not an answer; treat a blank string as "not stated". */
const normalizeAnswer = (answer: Answer): Answer => {
  if (typeof answer !== "string") {
    return answer;
  }
  const trimmed = answer.trim();
  return trimmed.length === 0 ? null : trimmed;
};

/**
 * One outcome per question, whatever the model returned: a question the text
 * does not settle is `not_stated`, one the model skipped or answered in the
 * wrong shape fails by name instead of vanishing. Anchors are kept only when
 * they were in the prompt, and in prompt order.
 */
export const parseResearchAnswers = ({
  knownAnchorIds,
  output,
  questions,
}: ParseResearchAnswersOptions): ParsedResearchAnswer[] => {
  const anchorOrder = [...knownAnchorIds];

  return questions.map(({ columnId, content }) => {
    const entry = output[columnId];
    if (entry === undefined) {
      return {
        columnId,
        outcome: { state: "failed", failureReason: "missing_answer" },
      };
    }
    const validated = validateAnswerForContent({
      answer: normalizeAnswer(entry.answer),
      content,
    });
    if (Result.isError(validated)) {
      return {
        columnId,
        outcome: { state: "failed", failureReason: "wrong_type" },
      };
    }
    const cited = new Set(entry.anchorIds);
    const rationale = entry.rationale
      .trim()
      .slice(0, LIMITS.caseLawResearchAnswerRationaleChars);
    const anchorIds = anchorOrder.filter((anchorId) => cited.has(anchorId));
    const answer = statedAnswerContent(validated.value);
    return {
      columnId,
      outcome:
        answer === null
          ? { state: "not_stated", rationale, anchorIds }
          : { state: "answered", answer, rationale, anchorIds },
    };
  });
};

/** Longest excerpt one citation carries into the run record. */
const CITED_EXCERPT_CHARS = 300;

/**
 * The cited passages as justification blocks. One block per anchor, in the
 * order the anchors were sent, so the card renders them the way the reader
 * scrolls them.
 */
export const buildAnswerJustification = (
  anchorIds: readonly string[],
  excerptByAnchor: ReadonlyMap<string, string>,
): JustificationContent => ({
  version: 1,
  blocks: anchorIds.map((anchorId) => ({
    kind: "decision-passage",
    anchorId,
    excerpt: (excerptByAnchor.get(anchorId) ?? "").slice(
      0,
      CITED_EXCERPT_CHARS,
    ),
  })),
});

/**
 * A stored cell's answer, validated as field content on the way out.
 *
 * The column is JSONB written by this deployment, so a value that is not field
 * content means a writer drifted from the schema: it is reported and rendered
 * as the union's own error arm, never handed to the client as an unknown shape.
 */
export const parseStoredAnswerContent = (value: unknown): FieldContent => {
  if (Value.Check(fieldContentSchema, value)) {
    return value;
  }
  captureError(
    new DatabaseError({
      message: "Stored research answer is not field content",
    }),
    { source: "case-law-research-answers" },
  );
  return { version: 1, type: "error" };
};

/** A question as the route accepts it; the handler re-parses. */
export const researchQuestionSchema = v.pipe(
  v.string(),
  v.trim(),
  v.minLength(1),
  v.maxLength(CASE_LAW_RESEARCH_QUESTION_MAX_LENGTH),
);
