// Require strict-mode-compatible schemas for AI structured output.
//
// OpenAI validates the `Output.object` / `Output.array` response
// format with `strict: true` and rejects any object node without
// `additionalProperties: false`. `valibotSchema()` emits that marker
// only for `v.strictObject()` nodes, so passing it to `Output.*`
// 400s on OpenAI as soon as a plain `v.object()` appears anywhere in
// the schema. `strictOutputSchema()` (apps/api/src/lib/
// ai-output-schema.ts) is the same conversion with the marker pinned
// on every object node.

import { eslintCompatPlugin, type Ranged } from "@oxlint/plugins";

import { isIdentifier, isMemberAccess } from "./utils.ts";

type CallExpressionNode = Ranged;

const isAstValue = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isRangedAstValue = (
  value: unknown,
): value is Ranged & Record<string, unknown> =>
  isAstValue(value) &&
  Array.isArray(value.range) &&
  value.range.length === 2 &&
  value.range.every((offset) => typeof offset === "number");

// Depth-first scan for `valibotSchema(...)` calls inside an argument
// subtree. Oxlint AST nodes carry parent back-references, so the walk
// skips `parent` and keeps a visited set to stay cycle-safe.
const findValibotSchemaCalls = (
  node: unknown,
  found: CallExpressionNode[],
  visited: WeakSet<object>,
): void => {
  if (Array.isArray(node)) {
    for (const item of node) {
      findValibotSchemaCalls(item, found, visited);
    }
    return;
  }
  if (!isAstValue(node) || visited.has(node)) {
    return;
  }
  visited.add(node);
  if (
    isRangedAstValue(node) &&
    node.type === "CallExpression" &&
    isIdentifier(node.callee, "valibotSchema")
  ) {
    found.push(node);
  }
  for (const [key, value] of Object.entries(node)) {
    if (key === "parent") {
      continue;
    }
    findValibotSchemaCalls(value, found, visited);
  }
};

export default eslintCompatPlugin({
  meta: { name: "ai-output-strict-schema" },
  rules: {
    "ai-output-strict-schema": {
      meta: {
        type: "problem",
        messages: {
          looseOutputSchema:
            "Use `strictOutputSchema` from `@/api/lib/ai-output-schema` " +
            "for `Output.*` schemas; `valibotSchema` is not OpenAI " +
            "strict-mode compatible.",
        },
      },
      createOnce(context) {
        return {
          CallExpression(node) {
            const isOutputCall =
              isMemberAccess(node.callee, "Output", "object") ||
              isMemberAccess(node.callee, "Output", "array");
            if (!isOutputCall) {
              return;
            }
            const found: CallExpressionNode[] = [];
            findValibotSchemaCalls(node.arguments, found, new WeakSet());
            for (const call of found) {
              context.report({ node: call, messageId: "looseOutputSchema" });
            }
          },
        };
      },
    },
  },
});
