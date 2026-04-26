import type { BlockDirectiveKind } from "@/api/handlers/docx/types";
import { isRecord } from "@/api/lib/type-guards";

export type ClauseRun = {
  text: string;
  bold?: boolean;
  italic?: boolean;
};

export type ClauseParagraph = {
  text: string;
  style?: string;
  level?: number;
  runs?: ClauseRun[];
  isDirective?: boolean;
  directiveKind?: BlockDirectiveKind;
  directiveExpression?: string;
};

export type ClauseBody = ClauseParagraph[];

export const isClauseParagraph = (value: unknown): value is ClauseParagraph => {
  if (!isRecord(value)) {
    return false;
  }
  return typeof value["text"] === "string";
};

export const isClauseBody = (value: unknown): value is ClauseBody =>
  Array.isArray(value) && value.length > 0 && value.every(isClauseParagraph);
