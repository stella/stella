import type { BlockDirectiveKind } from "@/api/handlers/docx/types";

export type ClauseParagraph = {
  text: string;
  style?: string;
  level?: number;
  isDirective?: boolean;
  directiveKind?: BlockDirectiveKind;
  directiveExpression?: string;
};

export type ClauseBody = ClauseParagraph[];
