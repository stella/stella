// Buffer-object cleanup intents form a persisted lifecycle state machine. The
// database keeps a rollout-safe default for older application tasks, but every
// current source insert must choose its state explicitly so a new writer cannot
// silently inherit rollout behavior.
//
// Flags direct object literals and each object literal in a direct array:
//   tx.insert(bufferObjectCleanupIntents).values({ objectKey });
//   tx.insert(bufferObjectCleanupIntents).values([
//     { objectKey: firstKey, status: WRITING },
//     { objectKey: secondKey },
//   ]);
//
// Allows explicit non-undefined state expressions, inserts into other tables,
// and payloads assembled in variables. The last case is an intentional
// syntax-analysis boundary: this rule does not claim to resolve arbitrary data
// flow.

import { eslintCompatPlugin } from "@oxlint/plugins";

import {
  filenameForContext,
  getImportedName,
  getImportLocalName,
  getPropertyName,
  isAstNode,
  isIdentifier,
  isStringLiteral,
  unwrapExpression,
} from "./utils.ts";

const RULE_NAME = "require-buffer-cleanup-intent-status";
const TABLE_NAME = "bufferObjectCleanupIntents";
const FIXTURE_PATH =
  ".oxlint-plugins/__fixtures__/require-buffer-cleanup-intent-status.fixture.ts";

const isSchemaModule = (specifier: string): boolean =>
  specifier === "@/api/db/schema" ||
  /(?:^|\/)db\/schema(?:\/entities)?(?:\.ts)?$/u.test(specifier);

const isUndefinedExpression = (node: unknown): boolean => {
  const expression = unwrapExpression(node);
  return (
    isIdentifier(expression, "undefined") ||
    (expression?.type === "UnaryExpression" && expression.operator === "void")
  );
};

const objectHasExplicitStatus = (node: unknown): boolean => {
  const object = unwrapExpression(node);
  if (
    object?.type !== "ObjectExpression" ||
    !Array.isArray(object.properties)
  ) {
    return false;
  }
  return object.properties.some((property) => {
    if (
      !isAstNode(property) ||
      property.type !== "Property" ||
      getPropertyName(property.key) !== "status"
    ) {
      return false;
    }
    return !isUndefinedExpression(property.value);
  });
};

const getInsertedTable = (valuesCall: unknown): unknown => {
  if (!isAstNode(valuesCall) || valuesCall.type !== "CallExpression") {
    return null;
  }
  const valuesCallee = unwrapExpression(valuesCall.callee);
  if (
    valuesCallee?.type !== "MemberExpression" ||
    getPropertyName(valuesCallee.property) !== "values"
  ) {
    return null;
  }
  const insertCall = unwrapExpression(valuesCallee.object);
  if (insertCall?.type !== "CallExpression") {
    return null;
  }
  const insertCallee = unwrapExpression(insertCall.callee);
  if (
    insertCallee?.type !== "MemberExpression" ||
    getPropertyName(insertCallee.property) !== "insert" ||
    !Array.isArray(insertCall.arguments)
  ) {
    return null;
  }
  return insertCall.arguments.at(0) ?? null;
};

export default eslintCompatPlugin({
  meta: { name: RULE_NAME },
  rules: {
    [RULE_NAME]: {
      meta: {
        type: "problem",
        messages: {
          missingStatus:
            "Set status explicitly when inserting bufferObjectCleanupIntents; current writers must not inherit the database rollout default.",
        },
        schema: [],
      },
      createOnce(context) {
        const directBindings = new Set<string>();
        const namespaceBindings = new Set<string>();

        const isCleanupIntentTable = (node: unknown): boolean => {
          const table = unwrapExpression(node);
          if (isIdentifier(table)) {
            return directBindings.has(table.name);
          }
          return (
            table?.type === "MemberExpression" &&
            isIdentifier(table.object) &&
            namespaceBindings.has(table.object.name) &&
            getPropertyName(table.property) === TABLE_NAME
          );
        };

        const reportMissingStatus = (payload: unknown): void => {
          const expression = unwrapExpression(payload);
          if (expression?.type === "ObjectExpression") {
            if (!objectHasExplicitStatus(expression)) {
              context.report({ node: expression, messageId: "missingStatus" });
            }
            return;
          }
          if (
            expression?.type !== "ArrayExpression" ||
            !Array.isArray(expression.elements)
          ) {
            return;
          }
          for (const element of expression.elements) {
            const object = unwrapExpression(element);
            if (
              object?.type === "ObjectExpression" &&
              !objectHasExplicitStatus(object)
            ) {
              context.report({ node: object, messageId: "missingStatus" });
            }
          }
        };

        return {
          before() {
            directBindings.clear();
            namespaceBindings.clear();
            const filename = filenameForContext(context);
            return (
              filename.includes("apps/api/src/") ||
              filename.endsWith(FIXTURE_PATH)
            );
          },
          ImportDeclaration(node) {
            if (
              !isStringLiteral(node.source) ||
              !isSchemaModule(node.source.value) ||
              !Array.isArray(node.specifiers)
            ) {
              return;
            }
            for (const specifier of node.specifiers) {
              if (
                specifier.type === "ImportNamespaceSpecifier" &&
                isIdentifier(specifier.local)
              ) {
                namespaceBindings.add(specifier.local.name);
                continue;
              }
              if (getImportedName(specifier) !== TABLE_NAME) {
                continue;
              }
              const localName = getImportLocalName(specifier);
              if (localName !== null) {
                directBindings.add(localName);
              }
            }
          },
          CallExpression(node) {
            const table = getInsertedTable(node);
            if (
              table === null ||
              !isCleanupIntentTable(table) ||
              !Array.isArray(node.arguments)
            ) {
              return;
            }
            const payload = node.arguments.at(0);
            if (payload !== undefined) {
              reportMissingStatus(payload);
            }
          },
        };
      },
    },
  },
});
