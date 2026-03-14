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
  directiveKind?: "if" | "elseif" | "else" | "endif" | "each" | "endeach";
  directiveExpression?: string;
};
