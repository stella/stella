/**
 * Structured condition model for a no-code condition builder.
 *
 * A visual builder (all/any groups, nested subgroups, "answer to question X
 * is equal to Y") edits a `ConditionNode` tree; `serializeCondition` turns it
 * into the expression string that [[evaluateCondition]] already understands.
 * This is the bridge between the point-and-click UI and the engine — the UI
 * never hand-writes expression syntax.
 */

export type ConditionOperator = "==" | "!=" | ">" | "<" | ">=" | "<=";

export type ConditionRule = {
  kind: "rule";
  /** Field / named-question the rule tests. */
  variable: string;
  operator: ConditionOperator;
  value: string | number | boolean;
};

export type ConditionGroup = {
  kind: "group";
  /** `all` → joined with `and`; `any` → joined with `or`. */
  match: "all" | "any";
  children: ConditionNode[];
};

export type ConditionNode = ConditionRule | ConditionGroup;

/** Render a rule's right-hand value: strings are quoted/escaped, booleans and
 *  numbers are emitted bare (matching the engine's literal handling). */
const serializeValue = (value: string | number | boolean): string => {
  if (typeof value === "string") {
    return `"${value.replace(/\\/gu, "\\\\").replace(/"/gu, '\\"')}"`;
  }
  return String(value);
};

const serializeRule = (rule: ConditionRule): string =>
  `${rule.variable} ${rule.operator} ${serializeValue(rule.value)}`;

const serializeGroup = (group: ConditionGroup, top: boolean): string => {
  const parts = group.children
    .map((child) =>
      child.kind === "rule"
        ? serializeRule(child)
        : serializeGroup(child, false),
    )
    .filter((part) => part.length > 0);

  if (parts.length === 0) {
    return "";
  }
  if (parts.length === 1) {
    // A single child needs neither a joiner nor wrapping parentheses.
    return parts[0] ?? "";
  }

  const joined = parts.join(group.match === "all" ? " and " : " or ");
  // Nested groups are parenthesised to preserve and/or precedence; the
  // top-level group is not, to keep the expression clean.
  return top ? joined : `(${joined})`;
};

/**
 * Serialize a condition tree into an expression for `evaluateCondition`.
 * Returns an empty string for an empty tree (caller treats that as "no
 * condition" / always-visible).
 */
export const serializeCondition = (node: ConditionNode): string =>
  node.kind === "rule" ? serializeRule(node) : serializeGroup(node, true);
