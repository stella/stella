export type DecisionSectionType =
  | "header"
  | "history"
  | "argumentation"
  | "ruling"
  | "dissent"
  | "footer"
  | "unknown";

export type DecisionSection = {
  index: number;
  type: DecisionSectionType;
  title: string | null;
  text: string;
};

/** Empty AST placeholder for legal documents without a parser. */
export type EmptyAst = Record<string, never>;

/** Constant empty AST for sources without a parser. */
export const EMPTY_AST: EmptyAst = {};
