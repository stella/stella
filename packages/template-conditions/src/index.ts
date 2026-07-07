/**
 * Shared condition evaluation + marker grammar for DOCX templates. Small,
 * side-effect-free functions usable on both backend (Bun) and frontend
 * (browser).
 *
 * Boolean conditions are evaluated through the canonical `@stll/conditions`
 * AST and its single evaluator, so view filters, AI-extraction gating, and
 * template `{{#if ...}}` conditionals share one set of operators and semantics
 * and never drift apart. This module owns the template surface: the string
 * parser (`./parse`), the named-condition resolver, and the no-code builder
 * serializer (`./condition-builder`).
 */

import {
  evaluateCondition as evaluateConditionAst,
  type ConditionNode,
  type ConditionValue,
  type OperandResolver,
} from "@stll/conditions";

import { evaluateNumericExpression } from "./compute.js";
import { parseCondition } from "./parse.js";
import { resolvePath } from "./path.js";

export { resolvePath };

// ── Types ─────────────────────────────────────────────────

export type NamedCondition = {
  name: string;
  /** The `{{#if}}` expression string. Authoritative unless `node` is set. */
  expression: string;
  /**
   * The canonical AST, set when the condition cannot round-trip through the
   * expression string — i.e. it uses a `formula` operand the `{{#if}}` grammar
   * has no syntax for. When present it is evaluated directly and `expression`
   * is ignored.
   */
  node?: ConditionNode;
  label?: string;
};

/**
 * Maximum recursion depth for named condition resolution.
 * Prevents stack overflow when a long chain of named
 * conditions (A→B→C→...→Z) is evaluated without cycles.
 */
export const MAX_CONDITION_DEPTH = 50;

// ── Boolean condition evaluation ──────────────────────────

/**
 * Normalize a fill-bag value into a `ConditionValue` the shared evaluator
 * accepts: arrays become string arrays (multi-select fields hold their options
 * as strings, so membership tests like `parties contains "guarantor"` work
 * even when an element is numeric), primitives pass through, anything else is
 * stringified.
 */
const toConditionValue = (raw: unknown): ConditionValue => {
  if (raw === null || raw === undefined) {
    return raw;
  }
  if (Array.isArray(raw)) {
    return raw.map(String);
  }
  if (
    typeof raw === "string" ||
    typeof raw === "number" ||
    typeof raw === "boolean"
  ) {
    return raw;
  }
  // A non-scalar (a nested fill object) is not a meaningful condition operand.
  return undefined;
};

/**
 * Build the operand resolver for one evaluation. Only `path` operands need
 * resolving (the evaluator handles literals). A path is first matched against
 * the named conditions: a hit evaluates that condition's expression — so
 * `{{#if isCompany}}` and `{{#if isCompany and signed}}` both work — guarded
 * against cycles (`resolved`) and runaway chains (`MAX_CONDITION_DEPTH`).
 * Otherwise the path resolves against the fill data.
 */
const makeResolver = (
  data: Record<string, unknown>,
  namedConditions: readonly NamedCondition[] | undefined,
  resolved: ReadonlySet<string>,
  depth: number,
): OperandResolver => {
  const resolve: OperandResolver = (operand) => {
    // An arithmetic expression over numeric fields, resolved against the same
    // fill bag (`rent * 12`); a non-numeric/unparseable expression is undefined.
    if (operand.type === "formula") {
      return evaluateNumericExpression(operand.expr, data);
    }
    if (operand.type !== "path") {
      return undefined;
    }
    const { path } = operand;
    const named = namedConditions?.find((c) => c.name === path);
    if (named) {
      if (depth >= MAX_CONDITION_DEPTH || resolved.has(path)) {
        return false;
      }
      const next = new Set(resolved);
      next.add(path);
      // An AST-backed named condition (uses a formula operand) is evaluated
      // directly; a string-backed one re-parses its expression.
      if (named.node) {
        return evaluateConditionAst(
          named.node,
          makeResolver(data, namedConditions, next, depth + 1),
        );
      }
      return evaluateCondition(
        named.expression,
        data,
        namedConditions,
        next,
        depth + 1,
      );
    }
    return toConditionValue(resolvePath(path, data));
  };
  return resolve;
};

/**
 * Evaluate a template `{{#if ...}}` condition. The expression is parsed into
 * the canonical `@stll/conditions` AST and evaluated by the shared evaluator.
 *
 * Supports comparisons (`==`, `!=`, `>`, `<`, `>=`, `<=`), `contains`,
 * truthiness, negation (`!`), logical operators (`and`, `or`), parentheses,
 * dotted paths, numeric underscores, and named-condition references.
 *
 * An empty or unparseable expression is `false` ("no condition" never gates a
 * branch true).
 */
export const evaluateCondition = (
  expression: string,
  data: Record<string, unknown>,
  namedConditions?: readonly NamedCondition[],
  _resolved: ReadonlySet<string> = new Set(),
  _depth = 0,
): boolean => {
  const node = parseCondition(expression);
  if (node === null) {
    return false;
  }
  return evaluateConditionAst(
    node,
    makeResolver(data, namedConditions, _resolved, _depth),
  );
};

export { parseCondition } from "./parse.js";

// Value-returning arithmetic evaluator for computed fields. Kept separate
// from the boolean condition engine above; re-exported here as the package's
// single entry point.
export { evaluateNumericExpression } from "./compute.js";

// Single source of truth for the deterministic field-value transforms
// (composite, formula, date). Both the api fill engine and the web live
// preview render through renderDeterministicFieldValue so they cannot drift.
export {
  formatDate,
  renderComposite,
  renderDeterministicFieldValue,
} from "./field-values.js";
export type {
  DeterministicFieldConfig,
  FieldDateFormat,
  PartConfig,
} from "./field-values.js";

// The no-code condition builder edits the canonical `@stll/conditions` AST;
// `serializeCondition` renders it to the `{{#if}}` expression `evaluateCondition`
// parses. Re-export the AST surface so template consumers import from one place.
export { serializeCondition } from "./condition-builder.js";
export {
  conditionHasFormula,
  conditionNodeSchema,
  conditionSchema,
  emptyCondition,
} from "@stll/conditions";
export type {
  CompareNode,
  CompareOp,
  Condition,
  ConditionNode,
  GroupNode,
  Operand,
  PredicateNode,
  PredicateOp,
} from "@stll/conditions";

// Canonical `{{...}}` marker grammar — the single source of truth for every
// directive recognizer (api fill pipeline, folio editor, web preview).
export {
  assertNever,
  BLOCK_DIRECTIVE_KINDS,
  blockDirectiveLinePattern,
  classifyMarker,
  clauseSlotPattern,
  countPattern,
  DIRECTIVE_KINDS,
  hasBlockDirectivePattern,
  hasNumberingPattern,
  indexPattern,
  isBlockDirectiveKind,
  isClauseSlotName,
  isFieldPath,
  isSafeFieldPath,
  markerPattern,
  numPattern,
  placeholderPattern,
  refPattern,
  scanInvalidMarkers,
  scanMarkers,
} from "./markers.js";
export type {
  DirectiveKind,
  InvalidMarker,
  MarkerMeta,
  ScannedMarker,
} from "./markers.js";
