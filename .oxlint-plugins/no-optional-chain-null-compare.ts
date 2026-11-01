// An optional chain evaluates to `undefined` when it short-circuits. A
// comparison that is TRUE for `undefined` therefore reads "the object is
// absent" as a match: `row?.closedAt !== null` is true when `row` is undefined,
// and so are `row?.closedAt === undefined` and `row?.closedAt == null`.
//
// This plugin owns exactly those comparisons. The ones that are FALSE for
// `undefined` (`=== null`, `!== undefined`, `!= null`) mean the same as their
// narrowed spelling, so typescript/prefer-optional-chain owns them and asks for
// the optional chain. `chainComparisonOwner` is the single map of that split;
// each rule below reports one part of the forms this plugin owns.
//
// Say which question is meant:
//   the object exists and the value is set    x !== undefined && x.y !== null
//   absent and null mean the same             (x?.y ?? null) !== null
//   the object exists and the value is unset  x !== undefined && x.y === undefined
//   absent and unset mean the same            x?.y !== undefined, branches swapped,
//                                             or an early return for an absent x
//
// `x === undefined || x.y === undefined` would say the last one too, but
// prefer-optional-chain folds it back into `x?.y === undefined`.
//
// Flagged by no-optional-chain-null-compare:
//   if (log?.closedAt !== null) {}
// Flagged by no-optional-chain-absent-match:
//   const open = undefined === row?.closedAt;
//   if (row?.closedAt == null) {}
// Allowed:
//   if (log !== undefined && log.closedAt !== null) {}
//   if ((log?.closedAt ?? null) !== null) {}
//   if (log?.closedAt === null) {}

import {
  type CreateOnceRule,
  eslintCompatPlugin,
  type ESTree,
} from "@oxlint/plugins";
import { panic } from "better-result";

export type ChainComparisonOperator = "===" | "!==" | "==" | "!=";
export type NullishLiteral = "null" | "undefined";
export type ChainComparisonOwner =
  /** True when the chain short-circuits: an absent object reads as a match. */
  | "no-optional-chain-null-compare"
  | "no-optional-chain-absent-match"
  /** False when the chain short-circuits: same as the narrowed spelling. */
  | "prefer-optional-chain";

const trueForUndefined = (
  operator: ChainComparisonOperator,
  literal: NullishLiteral,
): boolean => {
  switch (operator) {
    case "===":
      return literal === "undefined";
    case "!==":
      return literal === "null";
    case "==":
      return true;
    case "!=":
      return false;
    default:
      operator satisfies never;
      return panic("Unhandled comparison operator");
  }
};

/** Which rule owns `x?.y <operator> <literal>`; every form has one owner. */
export const chainComparisonOwner = (
  operator: ChainComparisonOperator,
  literal: NullishLiteral,
): ChainComparisonOwner => {
  if (!trueForUndefined(operator, literal)) {
    return "prefer-optional-chain";
  }
  // `!== null` is the strict null form; the other absent-as-match forms
  // follow a dated rollout in scripts/guard-rollouts.
  return operator === "!==" && literal === "null"
    ? "no-optional-chain-null-compare"
    : "no-optional-chain-absent-match";
};

type OwnedRule = Exclude<ChainComparisonOwner, "prefer-optional-chain">;

const afterShortCircuit = (advice: string): string =>
  `An optional chain is \`undefined\` when it short-circuits, and this comparison is true for \`undefined\`, so an absent object reads as a match. ${advice}`;

const MESSAGES = {
  "no-optional-chain-null-compare": afterShortCircuit(
    "Narrow the object first (`x !== undefined && x.y !== null`) or fold " +
      "absence in explicitly (`(x?.y ?? null) !== null`).",
  ),
  // `x === undefined || x.y === undefined` is not offered: prefer-optional-chain
  // folds it back into the chain this rule reports.
  "no-optional-chain-absent-match": afterShortCircuit(
    "Write the absent case explicitly: flip to `x?.y !== undefined` with the " +
      "branches swapped, or return early when the object is absent. Use " +
      "`x !== undefined && x.y === undefined` when an absent object must not " +
      "count.",
  ),
} satisfies Record<OwnedRule, string>;

const nullishLiteral = (
  node: ESTree.Expression | ESTree.PrivateIdentifier,
): NullishLiteral | undefined => {
  if (node.type === "Literal" && node.value === null && node.raw === "null") {
    return "null";
  }
  if (node.type === "Identifier" && node.name === "undefined") {
    return "undefined";
  }
  return undefined;
};

const comparisonOperator = (
  operator: string,
): ChainComparisonOperator | undefined => {
  switch (operator) {
    case "===":
    case "!==":
    case "==":
    case "!=":
      return operator;
    default:
      return undefined;
  }
};

const ownedComparisonRule = (rule: OwnedRule): CreateOnceRule => ({
  meta: {
    type: "problem",
    messages: { absentAsMatch: MESSAGES[rule] },
  },
  createOnce(context) {
    return {
      BinaryExpression(node) {
        const operator = comparisonOperator(node.operator);
        if (operator === undefined) {
          return;
        }
        const { left, right } = node;
        const literal =
          left.type === "ChainExpression"
            ? nullishLiteral(right)
            : right.type === "ChainExpression"
              ? nullishLiteral(left)
              : undefined;
        if (
          literal !== undefined &&
          chainComparisonOwner(operator, literal) === rule
        ) {
          context.report({ node, messageId: "absentAsMatch" });
        }
      },
    };
  },
});

export default eslintCompatPlugin({
  meta: { name: "no-optional-chain-null-compare" },
  rules: {
    "no-optional-chain-null-compare": ownedComparisonRule(
      "no-optional-chain-null-compare",
    ),
    "no-optional-chain-absent-match": ownedComparisonRule(
      "no-optional-chain-absent-match",
    ),
  },
});
