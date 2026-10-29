// State claims belong to the verifier; the database independently invalidates
// inherited proof for every payload writer. This syntax guard follows stable
// local aliases/spreads and static SQL fragments. Arbitrary generated SQL,
// mutation through helpers and mutable object aliases need database enforcement.
import { type Context, eslintCompatPlugin } from "@oxlint/plugins";

import {
  filenameForContext,
  getPropertyName,
  isAstNode,
  isIdentifierReference,
  isTestFile,
  memberPropertyName,
  resolveImport,
  resolveVariable,
  stableInitializer,
  staticStringValue,
  unwrapExpression,
} from "./utils.ts";

const RULE_NAME = "no-direct-case-law-text-state-write";
const OWNER = "apps/api/src/lib/case-law/fulltext-state-store.ts";
const FIXTURE_FILE_SUFFIX =
  ".oxlint-plugins/__fixtures__/no-direct-case-law-text-state-write.fixture.ts";
const TABLE_MODULES = new Set([
  "apps/api/src/db/schema",
  "apps/api/src/db/schema/case-law",
]);

type InspectOptions = { context: Context; value: unknown; seen: Set<unknown> };
const stableValue = ({ context, value, seen }: InspectOptions) => {
  let node = unwrapExpression(value);
  while (isIdentifierReference(node) && !seen.has(node)) {
    seen.add(node);
    const variable = resolveVariable(context, node);
    node =
      variable === null ? null : unwrapExpression(stableInitializer(variable));
  }
  return node;
};
const containsState = ({ context, value, seen }: InspectOptions): boolean => {
  const node = stableValue({ context, value, seen });
  if (node?.type === "ArrayExpression" && Array.isArray(node.elements)) {
    return node.elements.some((element) =>
      containsState({ context, value: element, seen }),
    );
  }
  if (node?.type !== "ObjectExpression" || !Array.isArray(node.properties)) {
    return false;
  }
  return node.properties.some((property: unknown) => {
    if (!isAstNode(property)) {
      return false;
    }
    if (property.type === "SpreadElement") {
      return containsState({ context, value: property.argument, seen });
    }
    return (
      property.type === "Property" &&
      (property.computed
        ? staticStringValue(property.key)
        : getPropertyName(property.key)) === "textState"
    );
  });
};
const isDecisionTable = (context: Context, value: unknown) => {
  const binding = resolveImport(context, value);
  return (
    binding?.imported === "caseLawDecisions" &&
    TABLE_MODULES.has(binding.moduleId)
  );
};
const mutationChain = ({ context, value, seen }: InspectOptions): boolean => {
  const node = stableValue({ context, value, seen });
  if (node?.type !== "CallExpression") {
    return false;
  }
  const callee = unwrapExpression(node.callee);
  if (callee?.type !== "MemberExpression") {
    return false;
  }
  const method = memberPropertyName(callee);
  if (
    (method === "insert" || method === "update") &&
    Array.isArray(node.arguments) &&
    isDecisionTable(context, node.arguments.at(0))
  ) {
    return true;
  }
  return mutationChain({ context, value: callee.object, seen });
};
const sqlText = (context: Context, value: unknown): string | null => {
  const node = unwrapExpression(value);
  if (node?.type === "Literal") {
    return typeof node.value === "string" ? node.value : null;
  }
  if (
    node?.type !== "TemplateLiteral" ||
    !Array.isArray(node.quasis) ||
    !Array.isArray(node.expressions)
  ) {
    return null;
  }
  const expressions = node.expressions;
  return node.quasis
    .map((quasi: unknown, index) => {
      const expression = unwrapExpression(expressions.at(index));
      let interpolation = staticStringValue(expression) ?? " ? ";
      if (isDecisionTable(context, expression)) {
        interpolation = "case_law_decisions";
      }
      if (
        expression?.type === "MemberExpression" &&
        isDecisionTable(context, expression.object)
      ) {
        interpolation =
          memberPropertyName(expression) === "textState" ? "text_state" : " ? ";
      }
      const text =
        isAstNode(quasi) &&
        typeof quasi.value === "object" &&
        quasi.value !== null &&
        "raw" in quasi.value &&
        typeof quasi.value.raw === "string"
          ? quasi.value.raw
          : "";
      return `${text}${interpolation}`;
    })
    .join("");
};
const mutatesSqlState = (text: string) => {
  const source = text
    .replace(/--[^\n]*|\/\*[\s\S]*?\*\//gu, " ")
    .replaceAll('"', "");
  return (
    /\bUPDATE\s+(?:public\.)?case_law_decisions\b[^;]*\bSET\b[^;]*\btext_state\s*=/iu.test(
      source,
    ) ||
    /\bINSERT\s+INTO\s+(?:public\.)?case_law_decisions\s*\([^)]*\btext_state\b/iu.test(
      source,
    ) ||
    /\bINSERT\s+INTO\s+(?:public\.)?case_law_decisions\b[^;]*\bDO\s+UPDATE\s+SET\b[^;]*\btext_state\s*=/iu.test(
      source,
    )
  );
};

export default eslintCompatPlugin({
  meta: { name: RULE_NAME },
  rules: {
    [RULE_NAME]: {
      meta: {
        type: "problem",
        schema: [],
        messages: {
          directWrite:
            "Write decision text state only through lib/case-law/fulltext-state-store.ts, after verifying readable text or typed publisher evidence.",
        },
      },
      createOnce(context) {
        return {
          before() {
            const filename = filenameForContext(context);
            return (
              filename.endsWith(FIXTURE_FILE_SUFFIX) ||
              (!filename.endsWith(OWNER) &&
                !isTestFile(filename) &&
                !filename.includes("/src/tests/") &&
                (filename.includes("/apps/") || filename.includes("/scripts/")))
            );
          },
          CallExpression(node) {
            const callee = unwrapExpression(node.callee);
            if (callee?.type !== "MemberExpression") {
              return;
            }
            const method = memberPropertyName(callee);
            if (
              !new Set(["set", "values", "onConflictDoUpdate"]).has(
                method ?? "",
              )
            ) {
              return;
            }
            if (
              !mutationChain({ context, value: callee.object, seen: new Set() })
            ) {
              return;
            }
            let payload: unknown = node.arguments.at(0);
            if (method === "onConflictDoUpdate") {
              const options = stableValue({
                context,
                value: payload,
                seen: new Set(),
              });
              const property =
                options?.type === "ObjectExpression" &&
                Array.isArray(options.properties)
                  ? options.properties.find(
                      (candidate: unknown) =>
                        isAstNode(candidate) &&
                        candidate.type === "Property" &&
                        getPropertyName(candidate.key) === "set",
                    )
                  : undefined;
              payload =
                isAstNode(property) && property.type === "Property"
                  ? property.value
                  : undefined;
            }
            if (containsState({ context, value: payload, seen: new Set() })) {
              context.report({ node, messageId: "directWrite" });
            }
          },
          Literal(node) {
            const text = sqlText(context, node);
            if (text !== null && mutatesSqlState(text)) {
              context.report({ node, messageId: "directWrite" });
            }
          },
          TemplateLiteral(node) {
            const text = sqlText(context, node);
            if (text !== null && mutatesSqlState(text)) {
              context.report({ node, messageId: "directWrite" });
            }
          },
        };
      },
    },
  },
});
