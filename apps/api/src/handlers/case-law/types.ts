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
