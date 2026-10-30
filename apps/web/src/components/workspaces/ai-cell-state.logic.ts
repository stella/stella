import { panic } from "better-result";

import type { QuestionAnswer } from "@/features/case-law/research/question-columns.logic";
import type { WorkspaceField } from "@/lib/types";

export type AiCellState =
  | { type: "not_run" }
  | { type: "queued" }
  | { type: "running" }
  | { type: "done" }
  | { type: "not_stated" }
  | { type: "failed" }
  | { type: "refused"; reason: "modelRefusal" }
  | { type: "refused_budget" };

export const propertyAiCellState = (
  field: Pick<WorkspaceField, "aiSettlement" | "content"> | undefined,
): AiCellState => {
  if (field === undefined) {
    return { type: "not_run" };
  }
  const { aiSettlement, content } = field;
  if (aiSettlement !== null && aiSettlement !== undefined) {
    switch (aiSettlement.type) {
      case "value":
        return { type: "done" };
      case "notStated":
        return { type: "not_stated" };
      case "refused":
        return { type: "refused", reason: aiSettlement.reason };
      case "failed":
        return { type: "failed" };
      default:
        aiSettlement satisfies never;
        return panic("Unhandled AI cell settlement");
    }
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
    case "withdrawn":
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
