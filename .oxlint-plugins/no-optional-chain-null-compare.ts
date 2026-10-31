// An optional chain evaluates to `undefined` when it short-circuits, so a
// strict comparison with `null` treats "the object is absent" as "the value is
// present": `row?.closedAt !== null` is true when `row` is undefined.
//
// Say which question is meant:
//   the object exists and the value is null   x !== undefined && x.y === null
//   absent and null mean the same             (x?.y ?? null) === null
//
// Flagged:
//   if (log?.closedAt !== null) {}
//   const open = null === row?.closedAt;
// Allowed:
//   if (log !== undefined && log.closedAt !== null) {}
//   if ((log?.closedAt ?? null) !== null) {}
//   if (log?.closedAt !== undefined) {}

import { eslintCompatPlugin } from "@oxlint/plugins";

const MESSAGE =
  "An optional chain is `undefined` when it short-circuits, so comparing it " +
  "strictly with `null` reads an absent object as a present value. Narrow " +
  "the object first (`x !== undefined && x.y === null`) or fold absence in " +
  "explicitly (`(x?.y ?? null) === null`).";

type Operand = { type: string; value?: unknown; raw?: string };

const isNullLiteral = (node: Operand) =>
  node.type === "Literal" && node.value === null && node.raw === "null";

export default eslintCompatPlugin({
  meta: { name: "no-optional-chain-null-compare" },
  rules: {
    "no-optional-chain-null-compare": {
      meta: {
        type: "problem",
        messages: { absentAsPresent: MESSAGE },
      },
      createOnce(context) {
        return {
          BinaryExpression(node) {
            if (node.operator !== "===" && node.operator !== "!==") {
              return;
            }
            const { left, right } = node;
            if (
              (isNullLiteral(left) && right.type === "ChainExpression") ||
              (isNullLiteral(right) && left.type === "ChainExpression")
            ) {
              context.report({ node, messageId: "absentAsPresent" });
            }
          },
        };
      },
    },
  },
});
