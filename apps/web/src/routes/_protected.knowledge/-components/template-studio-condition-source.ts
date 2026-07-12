import type { ConditionNode } from "@stll/conditions";
import { isFieldPath } from "@stll/template-conditions";

import type { OperatorWordKey } from "@/routes/_protected.knowledge/-components/template-studio-outline";
import { humanizeConditionExpr } from "@/routes/_protected.knowledge/-components/template-studio-outline";
import type { StudioField } from "@/routes/_protected.knowledge/-components/template-studio-store";

export const booleanFieldForExpr = (
  expr: string,
  fields: readonly StudioField[],
): StudioField | undefined => {
  const trimmed = expr.trim();
  if (trimmed === "" || !isFieldPath(trimmed)) {
    return undefined;
  }
  const field = fields.find((f) => f.path === trimmed);
  return field?.inputType === "boolean" ? field : undefined;
};

// ── Conditions = boolean fields ──────────────────────────

/** How a boolean field's yes/no value arises. The three are mutually
 *  exclusive (backend-validated):
 *   - asked: a plain boolean, answered Yes/No in the fill form (a question).
 *   - rule:  DERIVED from `condition` (a `@stll/template-conditions` rule).
 *   - ai:    decided by the model from `aiPrompt`.
 *  A boolean field is always a reusable condition; this discriminates only
 *  *how* it resolves. */
export type ConditionSource =
  | { kind: "asked" }
  | { kind: "rule"; expr: string; node?: ConditionNode }
  | { kind: "ai"; prompt: string };

export const conditionSourceOf = (field: StudioField): ConditionSource => {
  // An AST is authoritative when set (formula rules have no `{{#if}}` string
  // form, so they only ever round-trip as the AST).
  if (field.conditionAst !== undefined) {
    return { kind: "rule", expr: "", node: field.conditionAst };
  }
  if (field.condition !== undefined && field.condition.trim() !== "") {
    return { kind: "rule", expr: field.condition };
  }
  if (field.aiPrompt !== undefined && field.aiPrompt.trim() !== "") {
    return { kind: "ai", prompt: field.aiPrompt };
  }
  return { kind: "asked" };
};

const isBooleanField = (field: StudioField): boolean =>
  field.inputType === "boolean";

/** One reusable condition the picker can insert: every boolean field (its bare
 *  path is the gate). Shown in plain language; inserting references it by path
 *  so editing the source once updates every `{{#if}}` that points at it. */
type ReusableCondition = {
  /** The token a marker references: the field path. */
  ref: string;
  /** Plain-language reading for the list. */
  label: string;
  source: "asked" | "rule" | "ai";
};

/** Plain-language label for a condition-field: its own label, else the
 *  humanized rule, else the field path. */
const conditionFieldLabel = (
  field: StudioField,
  fields: readonly StudioField[],
  operatorWord: (key: OperatorWordKey) => string,
): string => {
  if (field.label.trim() !== "") {
    return field.label;
  }
  const source = conditionSourceOf(field);
  if (source.kind === "rule") {
    return humanizeConditionExpr(source.expr, fields, operatorWord);
  }
  return field.path;
};

/** Enumerate reusable conditions from the session: every boolean field is a
 *  condition addressed by its own path. */
export const reusableConditions = (
  fields: readonly StudioField[],
  operatorWord: (key: OperatorWordKey) => string,
): ReusableCondition[] => {
  const out: ReusableCondition[] = [];
  for (const field of fields) {
    if (!isBooleanField(field)) {
      continue;
    }
    const source = conditionSourceOf(field);
    out.push({
      ref: field.path,
      label: conditionFieldLabel(field, fields, operatorWord),
      source: source.kind,
    });
  }
  return out;
};
