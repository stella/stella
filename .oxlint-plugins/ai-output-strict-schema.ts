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

import { isIdentifier, isMemberAccess } from "./utils.ts";

type RuleContext = {
  report: (diagnostic: { node: unknown; messageId: string }) => void;
};

type CallExpressionNode = {
  type: "CallExpression";
  callee: unknown;
  arguments: unknown[];
};

const isAstValue = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

// Depth-first scan for `valibotSchema(...)` calls inside an argument
// subtree. Oxlint AST nodes carry parent back-references, so the walk
// skips `parent` and keeps a visited set to stay cycle-safe.
const findValibotSchemaCalls = (
  node: unknown,
  found: unknown[],
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
    node["type"] === "CallExpression" &&
    isIdentifier(node["callee"], "valibotSchema")
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

export default {
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
      create(context: RuleContext) {
        return {
          CallExpression(node: CallExpressionNode) {
            const isOutputCall =
              isMemberAccess(node.callee, "Output", "object") ||
              isMemberAccess(node.callee, "Output", "array");
            if (!isOutputCall) {
              return;
            }
            const found: unknown[] = [];
            findValibotSchemaCalls(node.arguments, found, new WeakSet());
            for (const call of found) {
              context.report({ node: call, messageId: "looseOutputSchema" });
            }
          },
        };
      },
    },
  },
};
