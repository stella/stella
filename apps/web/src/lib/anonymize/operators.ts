import type {
  AnonymisationOperator,
  OperatorConfig,
  OperatorType,
} from "./types";

// ── Operator registry ──────────────────────────────────

const replaceOperator: AnonymisationOperator = {
  type: "replace",
  reversibility: "reversible",
  apply: (_text, _label, placeholder) => placeholder,
};

const redactOperator: AnonymisationOperator = {
  type: "redact",
  reversibility: "irreversible",
  apply: (_text, _label, _placeholder, redactString) => redactString,
};

export const OPERATOR_REGISTRY = {
  replace: replaceOperator,
  redact: redactOperator,
} as const satisfies Record<OperatorType, AnonymisationOperator>;

const DEFAULT_REDACT_STRING = "[REDACTED]";

/**
 * Default operator config: replace for all labels.
 * Preserves existing pipeline behaviour.
 */
export const DEFAULT_OPERATOR_CONFIG: OperatorConfig = {
  operators: {},
  redactString: DEFAULT_REDACT_STRING,
};

/**
 * Resolve the operator for a label, falling back to "replace".
 */
export const resolveOperator = (
  config: OperatorConfig,
  label: string,
): OperatorType => config.operators[label] ?? "replace";
