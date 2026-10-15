import {
  BLOCK_DIRECTIVE_KINDS,
  type BlockDirectiveKind,
} from "@stll/template-conditions";

import { includes, isRecord, isUnknownArray } from "@/api/lib/type-guards";

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

const normalizeClauseRuns = (value: unknown): ClauseRun[] | undefined => {
  if (!isUnknownArray(value)) {
    return undefined;
  }
  const runs: ClauseRun[] = [];
  for (const run of value) {
    if (!isRecord(run) || typeof run["text"] !== "string") {
      return undefined;
    }
    const normalized = {
      text: run["text"],
      ...(typeof run["bold"] === "boolean" ? { bold: run["bold"] } : {}),
      ...(typeof run["italic"] === "boolean" ? { italic: run["italic"] } : {}),
    };
    true satisfies keyof ClauseRun extends keyof typeof normalized
      ? true
      : never;
    runs.push(normalized);
  }
  return runs;
};

// Imported paragraphs preserve extensions and may contain invalid optional
// fields. Preconditions compare recognized content, independent of extensions
// and transport spelling, without relaxing validation of a newly written body.
export const normalizeClauseBody = (
  body: readonly { text: string }[],
): ClauseBody =>
  body.map((paragraph) => {
    const fields: Record<string, unknown> = paragraph;
    const style = fields["style"];
    const level = fields["level"];
    const listKind = fields["listKind"] ?? fields["list_kind"];
    const listLevel = fields["listLevel"] ?? fields["list_level"];
    const isDirective = fields["isDirective"] ?? fields["is_directive"];
    const directiveKind = fields["directiveKind"] ?? fields["directive_kind"];
    const directiveExpression =
      fields["directiveExpression"] ?? fields["directive_expression"];
    const runs = normalizeClauseRuns(fields["runs"]);
    const normalized = {
      text: paragraph.text,
      ...(typeof style === "string" ? { style } : {}),
      ...(typeof level === "number" && Number.isInteger(level)
        ? { level }
        : {}),
      ...(typeof listKind === "string" && includes(CLAUSE_LIST_KINDS, listKind)
        ? { listKind }
        : {}),
      ...(typeof listLevel === "number" && Number.isInteger(listLevel)
        ? { listLevel }
        : {}),
      ...(typeof isDirective === "boolean" ? { isDirective } : {}),
      ...(typeof directiveKind === "string" &&
      includes(BLOCK_DIRECTIVE_KINDS, directiveKind)
        ? { directiveKind }
        : {}),
      ...(typeof directiveExpression === "string"
        ? { directiveExpression }
        : {}),
      ...(runs === undefined ? {} : { runs }),
    };
    true satisfies keyof ClauseParagraph extends keyof typeof normalized
      ? true
      : never;
    return normalized;
  });

const isClauseParagraph = (value: unknown): value is ClauseParagraph => {
  if (!isRecord(value)) {
    return false;
  }
  return typeof value["text"] === "string";
};

export const isClauseBody = (value: unknown): value is ClauseBody =>
  Array.isArray(value) && value.length > 0 && value.every(isClauseParagraph);
