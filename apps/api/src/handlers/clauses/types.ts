import type { BlockDirectiveKind } from "@/api/handlers/docx/types";

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
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const obj = value as Record<string, unknown>;
  return typeof obj.text === "string";
};

export const isClauseBody = (value: unknown): value is ClauseBody => {
  return (
    Array.isArray(value) && value.length > 0 && value.every(isClauseParagraph)
  );
};
