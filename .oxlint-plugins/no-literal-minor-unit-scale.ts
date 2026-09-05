import { eslintCompatPlugin } from "@oxlint/plugins";

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
// The rule reads names, not types: it fires when the other operand is an
// identifier or a member whose name ends in one of the money words below. That
// deliberately leaves percentage arithmetic alone (`(minutes * percentage) /
// 100`, `(amountCents * (100 + markupPercent) + 50) / 100`), where 100 is the
// percent base and neither operand is a bare money name.

const MONEY_NAME_SUFFIXES = ["cents", "amount", "rate", "total", "price"];

const HUNDRED = 100;

const isMoneyName = (name) => {
  const lowered = name.toLowerCase();
  return MONEY_NAME_SUFFIXES.some((suffix) => lowered.endsWith(suffix));
};

const isMoneyOperand = (node) => {
  if (node.type === "Identifier") {
    return isMoneyName(node.name);
  }
  if (
    (node.type === "MemberExpression" ||
      node.type === "OptionalMemberExpression") &&
    !node.computed &&
    node.property.type === "Identifier"
  ) {
    return isMoneyName(node.property.name);
  }
  return false;
};

const isHundred = (node) => node.type === "Literal" && node.value === HUNDRED;

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
