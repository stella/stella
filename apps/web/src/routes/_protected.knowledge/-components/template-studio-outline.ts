import type { DirectiveRange } from "@stll/folio-react";
import { isFieldPath } from "@stll/template-conditions";

import type {
  OutlineNode,
  StudioField,
} from "@/routes/_protected.knowledge/-components/template-studio-store";

export type OutlineRowItem = { node: OutlineNode; count: number };

/** Collapse sibling field nodes sharing a path into one row (keeping the first,
 *  earliest occurrence) with an occurrence count; non-field nodes pass through
 *  with count 1. Order is preserved (callers pass doc-sorted sibling lists). */
export const dedupeOutlineFields = (nodes: OutlineNode[]): OutlineRowItem[] => {
  const result: OutlineRowItem[] = [];
  const indexByPath = new Map<string, number>();
  for (const node of nodes) {
    if (node.type === "field") {
      const existing = indexByPath.get(node.path);
      if (existing !== undefined) {
        const item = result[existing];
        if (item) {
          item.count += 1;
        }
        continue;
      }
      indexByPath.set(node.path, result.length);
    }
    result.push({ node, count: 1 });
  }
  return result;
};

/** Folds the flat directive scan into the document's nesting: if/each
 *  markers open groups that own everything up to their closer, so the
 *  panel mirrors which fields only appear under a condition or repeat. */
export const buildOutline = (
  directives: readonly DirectiveRange[],
): OutlineNode[] => {
  const root: OutlineNode[] = [];
  const stack: OutlineNode[][] = [root];
  const top = () => stack.at(-1) ?? root;
  for (const d of directives.toSorted((a, b) => a.from - b.from)) {
    if (d.kind === "placeholder") {
      top().push({ type: "field", path: d.expr, from: d.from });
    } else if (d.kind === "clause") {
      top().push({ type: "clause", name: d.expr, from: d.from });
    } else if (d.kind === "if" || d.kind === "each") {
      const group: OutlineNode = {
        type: "group",
        kind: d.kind,
        expr: d.expr,
        from: d.from,
        children: [],
      };
      top().push(group);
      stack.push(group.children);
    } else if (d.kind === "elseif" || d.kind === "else") {
      // A branch closes the previous branch and opens a sibling group.
      if (stack.length > 1) {
        stack.pop();
      }
      const group: OutlineNode = {
        type: "group",
        kind: d.kind,
        expr: d.expr,
        from: d.from,
        children: [],
      };
      top().push(group);
      stack.push(group.children);
    } else if (
      (d.kind === "endif" || d.kind === "endeach") &&
      stack.length > 1
    ) {
      stack.pop();
    }
  }
  return root;
};

/** The rule-builder's param-less operator word keys; narrowed from the broad
 *  `TranslationKey` union so the row can call `t(key)` with a single argument
 *  (interpolating keys need a values object). */
export type OperatorWordKey =
  | "templates.conditionOpAtLeast"
  | "templates.conditionOpAtMost"
  | "templates.conditionOpIsNot"
  | "templates.conditionOpIs"
  | "templates.conditionOpGreaterThan"
  | "templates.conditionOpLessThan"
  | "templates.conditionOpContains";

/** Canonical comparison operators (as `serializeCondition` emits them) mapped
 *  to the rule-builder's word keys, longest first so `>=`/`<=`/`!=` win over
 *  their single-character prefixes when scanning an expression. */
const CONDITION_OPERATOR_WORDS: readonly {
  operator: string;
  labelKey: OperatorWordKey;
}[] = [
  { operator: ">=", labelKey: "templates.conditionOpAtLeast" },
  { operator: "<=", labelKey: "templates.conditionOpAtMost" },
  { operator: "!=", labelKey: "templates.conditionOpIsNot" },
  { operator: "==", labelKey: "templates.conditionOpIs" },
  { operator: ">", labelKey: "templates.conditionOpGreaterThan" },
  { operator: "<", labelKey: "templates.conditionOpLessThan" },
  { operator: "contains", labelKey: "templates.conditionOpContains" },
];

/** Strip matching surrounding quotes from a comparison's right-hand side so
 *  `state == "draft"` reads as `is draft`, not `is "draft"`. */
const unquote = (value: string): string => {
  const trimmed = value.trim();
  const first = trimmed.at(0);
  if (
    trimmed.length >= 2 &&
    (first === '"' || first === "'") &&
    trimmed.at(-1) === first
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
};

/** Friendly reading of a condition/loop opener for the outline row. Bare
 *  boolean field paths read as the field's label; binary comparisons read as
 *  `label operator-word value`; anything we can't prettify falls back to the
 *  raw expression. The raw expression stays available as the row's `title`. */
export const humanizeConditionExpr = (
  expr: string,
  fields: readonly StudioField[],
  operatorWord: (key: OperatorWordKey) => string,
): string => {
  const trimmed = expr.trim();
  if (trimmed === "") {
    return expr;
  }
  const labelFor = (path: string): string => {
    const field = fields.find((f) => f.path === path);
    return field !== undefined && field.label !== "" ? field.label : path;
  };
  // A bare field path with no operator is a yes/no question gating the block.
  if (isFieldPath(trimmed)) {
    return labelFor(trimmed);
  }
  for (const { operator, labelKey } of CONDITION_OPERATOR_WORDS) {
    const index = trimmed.indexOf(operator);
    if (index <= 0) {
      continue;
    }
    const lhs = trimmed.slice(0, index).trim();
    const rhs = trimmed.slice(index + operator.length).trim();
    if (lhs === "" || rhs === "" || !isFieldPath(lhs)) {
      continue;
    }
    return `${labelFor(lhs)} ${operatorWord(labelKey)} ${unquote(rhs)}`;
  }
  return trimmed;
};

export const outlineFieldPaths = (nodes: OutlineNode[]): Set<string> => {
  const paths = new Set<string>();
  const walk = (list: OutlineNode[]) => {
    for (const node of list) {
      if (node.type === "field") {
        paths.add(node.path);
      }
      if (node.type === "group") {
        walk(node.children);
      }
    }
  };
  walk(nodes);
  return paths;
};
