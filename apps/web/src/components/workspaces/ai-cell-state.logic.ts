import { panic } from "better-result";

import type { QuestionAnswer } from "@/features/case-law/research/question-columns.logic";
import type { WorkspaceFieldContent } from "@/lib/types";

export type AiCellState =
  | { type: "not_run" }
  | { type: "queued" }
  | { type: "running" }
  | { type: "done" }
  | { type: "failed" }
  | { type: "refused_budget" };

export const propertyAiCellState = (
  content: WorkspaceFieldContent | undefined,
): AiCellState => {
  if (content === undefined) {
    return { type: "not_run" };
  }
  switch (content.type) {
    case "pending":
      return { type: "running" };
    case "error":
      return { type: "failed" };
    case "unsupported":
    case "text":
    case "single-select":
    case "multi-select":
    case "file":
    case "date":
    case "int":
    case "money":
    case "person":
    case "clip":
      return { type: "done" };
    default:
      content satisfies never;
      return panic("Unhandled matter field state");
  }
};

type QuestionAiCellStateOptions = {
  answer: QuestionAnswer | undefined;
  queued?: boolean;
  refusedBudget?: boolean;
};

export const questionAiCellState = ({
  answer,
  queued = false,
  refusedBudget = false,
}: QuestionAiCellStateOptions): AiCellState => {
  if (refusedBudget) {
    return { type: "refused_budget" };
  }
  if (queued) {
    return { type: "queued" };
  }
  if (answer === undefined) {
    return { type: "not_run" };
  }
  switch (answer.state) {
    case "pending":
      return { type: "running" };
    case "answered":
    case "not_stated":
      return { type: "done" };
    // Source licensing is a failure to answer, never a budget refusal.
    case "not_allowed":
    case "failed":
      return { type: "failed" };
    default:
      answer.state satisfies never;
      return panic("Unhandled research answer state");
  }
};
