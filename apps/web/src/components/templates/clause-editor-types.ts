import type { FolioAIEditOperation } from "@stll/folio-core";
import type { BlockDirectiveKind } from "@stll/template-conditions";

export type ClauseRun = {
  text: string;
  bold?: boolean;
  italic?: boolean;
};

export type ClauseListKind = "bullet" | "ordered";

type ClauseNumbering = Extract<
  Extract<
    FolioAIEditOperation,
    { type: "setBlockParagraphProperties" }
  >["properties"]["numbering"],
  { kind: "levelOnly" }
>;

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
  numbering?: ClauseNumbering;
};

export type ClauseBody = ClauseParagraph[];
