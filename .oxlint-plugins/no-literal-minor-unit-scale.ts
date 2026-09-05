import { eslintCompatPlugin } from "@oxlint/plugins";

import { type AstNode, filenameForContext, isAstNode } from "./utils.ts";

// Scaling money by a literal 100 hard-codes an exponent the currency owns.
//
// Money is stored in minor units, and how many of them make a major one is a
// property of the currency: 100 for USD and CZK, but 1 for JPY and 1000 for
// KWD. A `* 100` on the way in and a `/ 100` on the way out therefore store a
// yen amount a hundred times too small and a dinar amount ten times too large,
// and nothing fails: the number is plausible, the column is an integer, and
// the error only surfaces on an invoice.
//
// `toMinorUnits({ amount, currency })` and `toMajorUnits({ amountCents,
// currency })` in `@stll/money` ask the currency instead. They are the only
// conversion in the codebase, so this rule is what keeps a new call site from
// re-deriving the wrong one.
//
// The rule reads shapes and names, not types. An operand is money when it
// PARSES a number out of text (`Number.parseFloat(input) * 100`) or when a
// money-named identifier appears anywhere inside it, at any depth --
// `(defaultValues?.amount ?? 0) / 100` and `(row.totalCents + fee) / 100` are
// the same defect as the bare identifier, and matching only the immediate
// operand missed every production spelling of it.
//
// Percentage arithmetic against a 100 base has the same shape whenever a money
// value is one of its factors (`(amountCents * (100 + markupPercent) + 50) /
// 100`), so the one module that owns that contract is exempt by name rather
// than by a heuristic that would have to guess.

const MONEY_NAME_SUFFIXES = ["cents", "amount", "rate", "total", "price"];

// Calls that PRODUCE the number being scaled out of text: the operand carries
// no name to read, so the call itself is the evidence. A member call matches on
// its property (`Number.parseFloat`), so an aliased namespace does not slip
// past.
//
// `Math.round`, `Math.floor` and `Math.ceil` are deliberately not here.
// They only pass along whatever they were given, so the walk below already
// reports `Math.round(rawAmount) / 100` through the name inside; treating them
// as evidence on their own would report `Math.round(x * 100) / 100`, which is
// the round-to-two-decimals idiom and has nothing to do with money.
const PARSE_CALL_NAMES = new Set(["parseFloat", "parseInt", "Number"]);

const HUNDRED = 100;
// A `100n` is a `Literal` whose `value` is a bigint, so the number compare
// alone would let `amountCents / 100n` through.
const HUNDRED_BIGINT = 100n;

// `applyMarkupCents` and `prorateHourlyCents` express the markup and proration
// contracts, where 100 is the percent base and the money operand is the value
// being marked up. Everything else in the package, and every other module,
// stays under the rule.
const OWNING_MODULE = "packages/money/src/index.ts";

/** How deep the operand walk descends before it gives up. */
const MAX_OPERAND_DEPTH = 12;

/** Keys that lead back up the tree or hold positions rather than children. */
const NON_CHILD_KEYS = new Set(["parent", "range", "loc"]);

const identifierName = (node: unknown): string | undefined =>
  isAstNode(node) && node.type === "Identifier" && typeof node.name === "string"
    ? node.name
    : undefined;

/** The property of a non-computed member access, `a.b` but not `a[b]`. */
const memberPropertyName = (node: unknown): string | undefined => {
  if (
    !isAstNode(node) ||
    (node.type !== "MemberExpression" &&
      node.type !== "OptionalMemberExpression") ||
    node.computed === true
  ) {
    return undefined;
  }
  return identifierName(node.property);
};

const isMoneyName = (name: string): boolean => {
  const lowered = name.toLowerCase();
  return MONEY_NAME_SUFFIXES.some((suffix) => lowered.endsWith(suffix));
};

const isParseCall = (node: AstNode): boolean => {
  if (
    node.type !== "CallExpression" &&
    node.type !== "OptionalCallExpression"
  ) {
    return false;
  }
  const calleeName =
    identifierName(node.callee) ?? memberPropertyName(node.callee);
  return calleeName !== undefined && PARSE_CALL_NAMES.has(calleeName);
};

/** The child nodes of `node`, skipping the keys that are not children. */
const childValues = (node: AstNode): unknown[] =>
  Object.entries(node)
    .filter(([key]) => !NON_CHILD_KEYS.has(key))
    .flatMap(([, value]) => (Array.isArray(value) ? value : [value]));

// A money name anywhere in the operand, or a call that parses the number being
// scaled. Walks children rather than the source text so a name inside a string
// or a comment cannot trigger it.
const isMoneyOperand = (node: unknown, depth = 0): boolean => {
  if (!isAstNode(node) || depth > MAX_OPERAND_DEPTH) {
    return false;
  }
  const ownName = identifierName(node) ?? memberPropertyName(node);
  if (ownName !== undefined && isMoneyName(ownName)) {
    return true;
  }
  if (isParseCall(node)) {
    return true;
  }
  // An identifier that is not a money name has no children worth walking, and
  // a member's object still might (`policy.price.amountCents`).
  if (node.type === "Identifier") {
    return false;
  }
  return childValues(node).some((child) => isMoneyOperand(child, depth + 1));
};

const isHundred = (node: unknown): boolean =>
  isAstNode(node) &&
  node.type === "Literal" &&
  (node.value === HUNDRED || node.value === HUNDRED_BIGINT);

export default eslintCompatPlugin({
  meta: { name: "no-literal-minor-unit-scale" },
  rules: {
    "no-literal-minor-unit-scale": {
      meta: {
        type: "problem",
        messages: {
          literalScale:
            "Scaling money by a literal 100 assumes every currency has two " +
            "minor units; JPY has none and KWD has three. Convert with " +
            "toMinorUnits({ amount, currency }) or toMajorUnits({ amountCents, " +
            "currency }) from @stll/money, which ask the currency.",
        },
      },
      createOnce(context) {
        return {
          BinaryExpression(node) {
            // Read per file: `context.filename` is not available while the
            // rule is being registered.
            if (filenameForContext(context).endsWith(OWNING_MODULE)) {
              return;
            }
            const scales =
              node.operator === "*"
                ? (isHundred(node.right) && isMoneyOperand(node.left)) ||
                  (isHundred(node.left) && isMoneyOperand(node.right))
                : node.operator === "/" &&
                  isHundred(node.right) &&
                  isMoneyOperand(node.left);

            if (scales) {
              context.report({ node, messageId: "literalScale" });
            }
          },
        };
      },
    },
  },
});
