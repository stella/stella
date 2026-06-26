/**
 * Reads a stored extraction-gating condition back into the canonical
 * AST. Property dependencies persist a `ConditionNode | null`; a value
 * that does not validate as a `ConditionNode` (e.g. a stray pre-AST
 * row) is read as `null`, meaning "no gate" so the dependent property
 * always runs. There is no legacy-shape reader: resetting a stale
 * condition is acceptable (gating conditions are sparse and new).
 */
import * as v from "valibot";

import {
  type ConditionNode,
  conditionHasFormula,
  conditionNodeSchema,
} from "@stll/conditions";

export const parseStoredCondition = (value: unknown): ConditionNode | null =>
  v.is(conditionNodeSchema, value) && !conditionHasFormula(value)
    ? value
    : null;
