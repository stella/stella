import type { BlockDirectiveKind } from "@stll/template-conditions";

import { isRecord } from "@/api/lib/type-guards";

export type ClauseRun = {
  text: string;
  bold?: boolean;
  italic?: boolean;
};

export const CLAUSE_LIST_KINDS = ["bullet", "ordered"] as const;
export type ClauseListKind = (typeof CLAUSE_LIST_KINDS)[number];

export type ClauseParagraph = {
  text: string;
  style?: string;
  level?: number;
  runs?: ClauseRun[];
  isDirective?: boolean;
  directiveKind?: BlockDirectiveKind;
  directiveExpression?: string;
  /** When set, this paragraph is a list item; bullet or ordered. */
  listKind?: ClauseListKind;
  /** 0-based nesting depth of the list item (0 = top level). */
  listLevel?: number;
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
