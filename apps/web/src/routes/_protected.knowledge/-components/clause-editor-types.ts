export type ClauseRun = {
  text: string;
  bold?: boolean;
  italic?: boolean;
};

export type ClauseListKind = "bullet" | "ordered";

export type ClauseParagraph = {
  text: string;
  style?: string;
  level?: number;
  runs?: ClauseRun[];
  isDirective?: boolean;
  directiveKind?: "if" | "elseif" | "else" | "endif" | "each" | "endeach";
  directiveExpression?: string;
  /** When set, this paragraph is a list item; bullet or ordered. */
  listKind?: ClauseListKind;
  /** 0-based nesting depth of the list item (0 = top level). */
  listLevel?: number;
};
